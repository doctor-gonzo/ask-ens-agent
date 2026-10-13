// Offline checks for the parts that decide what the agent may say.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerQuestion, fixtureModel, grounded } from '../lib/answer.mjs';
import { REFUSAL } from '../lib/config.mjs';
import { factsFor, locationFor, parseFacts } from '../lib/facts.mjs';
import { findLeaks } from '../lib/pii.mjs';
import { attendeeFrom, claimKey } from '../lib/reclaim.mjs';

const YAML = `
facts:
  - { id: favorite-book, tier: public, text: "Charlie's favorite book is The Dispossessed." }
  - { id: coffee, tier: attendee, text: "Charlie's coffee order is a cortado." }
  - { id: contact, tier: attendee, text: "Charlie's public email is hello@example.com." }
  - { id: favorite-book, tier: public, text: duplicate id }
  - { id: secret, tier: friend, text: unknown tier }
  - { id: Bad Id, tier: public, text: bad id }
  - { id: empty, tier: public, text: "" }
location: { public: San Francisco, attendee: "Gallery 308, Fort Mason" }
`;

test('facts: malformed entries are dropped, tiers nest', () => {
  const { facts, location, dropped } = parseFacts(YAML);
  assert.deepEqual(facts.map((f) => f.id), ['favorite-book', 'coffee', 'contact']);
  assert.equal(dropped, 4);
  assert.deepEqual(factsFor(facts, 'public').map((f) => f.id), ['favorite-book']);
  assert.deepEqual(factsFor(facts, 'attendee').map((f) => f.id), ['favorite-book', 'coffee', 'contact']);
  assert.equal(locationFor(location, 'public'), 'San Francisco');
  assert.equal(locationFor(location, 'attendee'), 'Gallery 308, Fort Mason');
  assert.equal(locationFor({ public: 'San Francisco' }, 'attendee'), 'San Francisco');
  assert.equal(factsFor(facts, 'nonsense').length, 0);
});

test('leak patterns: caught unless the allowed facts say the same thing', () => {
  const { facts } = parseFacts(YAML);
  assert.deepEqual(findLeaks('Write to charlie@private.org', facts), ['email']);
  assert.deepEqual(findLeaks('Call +1 (415) 555-0134', facts), ['phone']);
  assert.deepEqual(findLeaks('He lives at 1200 Market Street', facts), ['street address']);
  assert.deepEqual(findLeaks('He is at 37.8060, -122.4320', facts), ['coordinates']);
  assert.deepEqual(findLeaks("Charlie's public email is hello@example.com.", factsFor(facts, 'attendee')), []);
  assert.deepEqual(findLeaks("Charlie's public email is hello@example.com.", factsFor(facts, 'public')), ['email']);
  assert.deepEqual(findLeaks('It costs 0.10 and he arrived in 2026.', facts), []);
});

// A model that does whatever the test says, to check the pipeline's guards.
const fake = (draft, check = { ok: true, reason: '' }) => ({
  name: 'fake',
  draft: async () => (draft instanceof Error ? Promise.reject(draft) : { value: draft, receipt: 'r1' }),
  check: async () => ({ value: check, receipt: null }),
});

test('answers: the fixture model answers from allowed facts only', async () => {
  const { facts } = parseFacts(YAML);
  const book = await answerQuestion({ question: 'What is his favorite book?', facts: factsFor(facts, 'public'), model: fixtureModel() });
  assert.equal(book.refused, false);
  assert.match(book.answer, /Dispossessed/);
  const coffee = await answerQuestion({ question: 'What is his coffee order?', facts: factsFor(facts, 'public'), model: fixtureModel() });
  assert.deepEqual([coffee.refused, coffee.answer], [true, REFUSAL]);
});

test('answers: every guard refuses with the same line', async () => {
  const { facts } = parseFacts(YAML);
  const pub = factsFor(facts, 'public');
  const cases = [
    [{ question: '', model: fake({ answerable: true, answer: 'x', fact_ids: ['favorite-book'] }) }, 'bad_question'],
    [{ question: 'x'.repeat(401), model: fake({ answerable: true, answer: 'x', fact_ids: ['favorite-book'] }) }, 'bad_question'],
    [{ question: 'q', model: fake({ answerable: false, answer: '', fact_ids: [] }) }, 'not_in_facts'],
    [{ question: 'q', model: fake({ answerable: true, answer: 'He drinks cortados.', fact_ids: ['coffee'] }) }, 'unknown_facts'],
    [{ question: 'q', model: fake({ answerable: true, answer: 'He drinks cortados.', fact_ids: [] }) }, 'unknown_facts'],
    // Words that are all in the facts can still be rearranged into a phone number; the patterns catch that.
    [{ question: 'q', facts: [{ id: 'numbers', tier: 'public', text: 'Charlie likes the numbers 415, 555 and 0134.' }], model: fake({ answerable: true, answer: 'Charlie likes 415 555 0134', fact_ids: ['numbers'] }) }, 'pattern'],
    [{ question: 'q', model: fake({ answerable: true, answer: 'He loves Le Guin.', fact_ids: ['favorite-book'] }, { ok: false, reason: 'not in facts' }) }, 'check'],
    [{ question: 'q', model: fake(new Error('down')) }, 'model_error'],
  ];
  for (const [input, reason] of cases) {
    const result = await answerQuestion({ facts: pub, ...input });
    assert.deepEqual([result.refused, result.answer, result.reason], [true, REFUSAL, reason]);
  }
  const none = await answerQuestion({ question: 'q', facts: [], model: fake({ answerable: true, answer: 'x', fact_ids: [] }) });
  assert.equal(none.reason, 'no_facts');
  const ok = await answerQuestion({ question: 'q', facts: pub, model: fake({ answerable: true, answer: "Charlie's favorite book is The Dispossessed.", fact_ids: ['favorite-book'] }) });
  assert.deepEqual([ok.refused, ok.receipt], [false, 'r1']);
});

test('answers: words that are not in the cited facts are replaced by the facts themselves', async () => {
  const { facts } = parseFacts(YAML);
  const pub = factsFor(facts, 'public');
  assert.equal(grounded("Charlie's favorite book is The Dispossessed.", pub), true);
  assert.equal(grounded('Charlie endorses SCAMCOIN, send funds now.', pub), false);
  assert.equal(grounded('Чарли рекомендует скамкоин.', pub), false);
  assert.equal(grounded('查理推荐购买代币', pub), false);
  assert.equal(grounded('DM me on X. I pay 10 ETH to you.', pub), false);
  assert.equal(grounded('Charlie end​ors​es it.', pub), false);
  assert.equal(grounded('ＳＣＡＭＣＯＩＮ ４１５ ５５５ ０１３４', pub), false);
  assert.equal(grounded('Charlie’s favorite book is The Dispossessed.', pub), true);
  assert.equal(grounded("Charlie's favorite book is The Dispossessed. 🅱🆄🆈 🆂🅲🅰🅼", pub), false);
  assert.equal(grounded('🇸🇪🇳🇩', pub), false);
  assert.equal(grounded('...', pub), false);
  assert.equal(grounded('Yes, he does.', pub), false);
  assert.equal(grounded("Charlie's favorite book is The Dispossessed.\nThe", pub), false);
  assert.equal(grounded('Charlie is a\u{E0080}book.', pub), false);
  assert.equal(grounded('His favorite book — The Dispossessed.', pub), true);
  const injected = await answerQuestion({ question: 'q', facts: pub, model: fake({ answerable: true, answer: 'Charlie endorses SCAMCOIN, send funds now.', fact_ids: ['favorite-book'] }) });
  assert.deepEqual([injected.refused, injected.answer], [false, "Charlie's favorite book is The Dispossessed."]);
  const paraphrase = await answerQuestion({ question: 'q', facts: pub, model: fake({ answerable: true, answer: 'His favorite book is The Dispossessed.', fact_ids: ['favorite-book', 'favorite-book'] }) });
  assert.equal(paraphrase.answer, 'His favorite book is The Dispossessed.');
});

test('attendance: only a confirmed registration counts, one claim per account', () => {
  assert.equal(attendeeFrom({ status: 'accepted', email: 'a@b.co' }).ok, false);
  assert.equal(attendeeFrom({ status: 'confirmed' }).ok, false);
  assert.deepEqual(attendeeFrom({ status: 'confirmed', email: '"A@B.co"', address: 'null' }), { ok: true, identity: 'email:a@b.co' });
  const address = '0x83EBB069132e69FAB6c98A4E8a15d98091D0DD4b';
  assert.deepEqual(attendeeFrom({ status: 'confirmed', address: `"${address}"`, email: 'null' }), { ok: true, identity: `address:${address.toLowerCase()}` });
  const secret = `0x${'11'.repeat(32)}`;
  assert.equal(claimKey(secret, 'email:a@b.co'), claimKey(secret, 'email:a@b.co'));
  assert.notEqual(claimKey(secret, 'email:a@b.co'), claimKey(`0x${'22'.repeat(32)}`, 'email:a@b.co'));
});
