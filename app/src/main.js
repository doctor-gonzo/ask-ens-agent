// The web app for agent.charliethompson.eth. A passkey is the visitor's Tempo
// account; questions are paid with MPP (Tempo testnet), and the agent sponsors
// the gas. Static files only, so it can live on IPFS behind the ENS name.
//
// Two cards: questions anyone can ask, and questions a credential unlocks
// (today a zkPass proof of Paradigm Frontiers registration; Reclaim when its
// provider exists).
import { Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { WebAuthnP256 as Passkey, PublicKey } from 'ox';
import { bytesToHex, createClient, formatUnits, http, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Abis, Account, WebAuthnP256 } from 'viem/tempo';
import { device, extensionInstalled, INSTALL_URL, openApp, prepare as prepareZkpass, runExtension, waitForRelay } from './zkpass.js';

const API = String(window.ASK_CONFIG?.api ?? '').replace(/\/+$/, '');
const EXPLORER = tempoModerato.blockExplorers.default.url; // the testnet explorer
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const PRICE = 100_000n; // 0.10
const RP_ID = location.hostname;
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
// Passkeys belong to the page's host, so only hosts that are this app's alone
// may create or use them (a shared IPFS gateway origin is not).
const OWN_HOST = LOCAL || /^agent\.charliethompson\.eth\.(link|limo)$/.test(location.hostname);

// What each credential would unlock. Only the Frontiers proof is live; the
// others show where this goes next.
const CREDENTIALS = {
  frontiers: { live: true }, // its button and note name whichever proof the agent takes
  friends: { live: false, questions: ['What are you working on?', 'Want to grab a coffee?'], unlock: 'Coming soon', note: 'A soulbound token from Charlie, which can carry a zkTLS proof, so closeness travels with you.' },
  colleagues: { live: false, questions: ["What's on your calendar this week?"], unlock: 'Coming soon', note: 'A proof that you have a work email at the same company, without revealing the address.' },
};

const $ = (id) => document.getElementById(id);
const rpc = createClient({ chain: tempoModerato, transport: http() }).extend(publicActions);
const state = { health: null, menu: { public: [], attendee: [] }, hidden: { attendee: 0 }, menuFor: null, account: null, mppx: null, tier: 'public', toy: 0n, usd: 0n, busy: false, preparing: false };

// Browser storage can be missing (private windows); the app still works without it.
const local = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `The agent answered ${res.status}.`), { code: body?.error?.code });
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function say(text, bad = false) {
  $('status').textContent = text ?? '';
  $('status').classList.toggle('bad', bad);
}
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (units) => `$${Number(formatUnits(units, 6)).toFixed(2)}`;
const isHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const txLink = (hash, text) => (isHash(hash) ? `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener noreferrer">${text}</a>` : '');
const cancelled = (error) => [error, error?.cause, error?.cause?.cause].some((e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError');

// A prepared proof request (first click), the current status poller, and the
// current zkPass run (a sign-out or a newer run calls off an older one).
let prepared = null;
let pollId = 0;
let unlockRun = 0;

// ---- The agent's health and its question menu ----

async function ensureHealth() {
  if (!state.health?.ready) {
    try { state.health = await api('/health'); } catch { return state.health; }
  }
  if (state.health?.ready && state.account && !state.mppx) buildPayments();
  return state.health;
}

// The menu depends on who's asking: questions above your tier stay hidden
// (the agent only says how many) until you're admitted. It is fetched on its
// own, so a failure here never stands in the way of paying.
async function loadMenu() {
  const address = state.account?.address ?? '';
  const key = `${address}:${state.tier}`;
  if (state.menuFor === key) return;
  try {
    const { tiers, hidden } = await api(`/questions${address ? `?for=${address}` : ''}`);
    if ((state.account?.address ?? '') !== address) return;
    const labels = (list) => (Array.isArray(list) ? list.filter((q) => typeof q === 'string') : []);
    state.menu = { public: labels(tiers?.public), attendee: labels(tiers?.attendee) };
    state.hidden = { attendee: Number.isInteger(hidden?.attendee) ? Math.max(0, Math.min(hidden.attendee, 12)) : 0 };
    state.menuFor = key;
  } catch {}
}

// ---- Account: a passkey (or, on localhost, a throwaway test key) ----

function buildPayments() {
  const health = state.health;
  if (!state.account || !health?.ready) { state.mppx = null; return; }
  const accepted = [PATHUSD, health.tokens.toy].map((token) => token.toLowerCase());
  state.mppx = Mppx.create({
    methods: [tempo.charge({ account: state.account, expectedChainId: tempoModerato.id, allowedChainIds: [tempoModerato.id], expectedRecipients: [health.agent], getClient: () => rpc })],
    polyfill: false,
    // Sign only what the page promises: 0.10 in pathUSD or TOY.
    onChallenge: async (challenge, { createCredential }) => {
      const request = challenge.request ?? {};
      if (String(request.amount) !== PRICE.toString() || !accepted.includes(String(request.currency).toLowerCase())) {
        throw new Error('The agent asked for an unexpected price, so nothing was paid.');
      }
      return createCredential();
    },
  });
}

function useAccount(saved) {
  prepared = null;
  pollId++;
  unlockRun++;
  state.preparing = false;
  if (saved?.kind === 'test' && !LOCAL) saved = null;
  if (saved?.kind === 'passkey' && !OWN_HOST) saved = null;
  // A new account sees only what it has unlocked, so the old menu goes too.
  Object.assign(state, { toy: 0n, usd: 0n, tier: 'public', mppx: null, menuFor: null, menu: { ...state.menu, attendee: [] } });
  state.account = !saved ? null : saved.kind === 'test' ? privateKeyToAccount(saved.key) : Account.fromWebAuthnP256({ id: saved.id, publicKey: saved.publicKey }, { rpId: RP_ID });
  buildPayments();
  render();
  return refresh();
}

async function login(choice) {
  let saved;
  let backedUp = true;
  if (choice === 'create') {
    const credential = await WebAuthnP256.createCredential({
      label: `agent.charliethompson.eth ${new Date().toISOString().slice(0, 10)}`,
      rpId: RP_ID,
      userId: crypto.getRandomValues(new Uint8Array(16)), // a new handle, so no earlier passkey is replaced
    });
    saved = { kind: 'passkey', id: credential.id, publicKey: credential.publicKey };
    backedUp = await post('/passkeys', { id: saved.id, publicKey: saved.publicKey }).then(() => true, () => false);
  } else if (choice === 'signin') {
    const known = local.get('ask:passkeys') ?? {};
    const challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    let fromServer = false;
    const credential = await WebAuthnP256.getCredential({
      rpId: RP_ID,
      hash: challenge,
      async getPublicKey(raw) {
        if (known[raw.id]) return known[raw.id];
        fromServer = true;
        return (await api(`/passkeys/${encodeURIComponent(raw.id)}`)).publicKey;
      },
    });
    // A key from the server is only trusted once it checks out against the passkey's signature.
    if (fromServer && !Passkey.verify({ challenge, metadata: credential.metadata, signature: credential.signature, publicKey: PublicKey.fromHex(credential.publicKey), rpId: RP_ID })) {
      throw new Error("That passkey doesn't match its saved key.");
    }
    saved = { kind: 'passkey', id: credential.id, publicKey: credential.publicKey };
  } else {
    saved = { kind: 'test', key: generatePrivateKey() };
  }
  if (saved.kind === 'passkey') local.set('ask:passkeys', { ...(local.get('ask:passkeys') ?? {}), [saved.id]: saved.publicKey });
  local.set('ask:account', saved);
  await useAccount(saved);
  if (choice !== 'signin') await faucet(true);
  if (!backedUp) say("Couldn't back up this passkey, so it only works on this device.", true);
}

function logout() {
  local.remove('ask:account');
  useAccount(null);
  for (const id of ['public-answer', 'locked-answer']) $(id).hidden = true;
  say('');
}

let afterLogin = null;
function openLogin(then) {
  if (!OWN_HOST) return say('Open agent.charliethompson.eth.link to sign in.', true);
  afterLogin = then ?? null;
  $('test-key').hidden = !LOCAL;
  $('login').returnValue = '';
  $('login').showModal();
}
$('login').addEventListener('close', async () => {
  const choice = $('login').returnValue;
  if (!['create', 'signin', 'test'].includes(choice)) return;
  try {
    await login(choice);
    const next = afterLogin;
    afterLogin = null;
    if (next) next();
  } catch (error) {
    say(cancelled(error) ? 'The passkey was cancelled.' : error.message, true);
  }
});

// ---- The account sheet: balance, top-ups, payments, sign-out ----

const historyKey = () => `ask:history:${state.account?.address}`;
function remember(entry) {
  if (state.account) local.set(historyKey(), [{ at: Date.now(), ...entry }, ...(local.get(historyKey()) ?? [])].slice(0, 50));
}

// Copies, then shows it worked for a moment: an icon button turns into a check.
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.querySelector('svg') ? null : button.textContent;
    button.classList.add('copied');
    if (label) button.textContent = 'Copied';
    setTimeout(() => { button.classList.remove('copied'); if (label) button.textContent = label; }, 1500);
  } catch {}
}

$('account').addEventListener('click', () => {
  if (!state.account) return openLogin();
  render();
  $('wallet-sheet').showModal();
  refresh();
});
$('wallet-sheet').addEventListener('click', (event) => {
  if (event.target === $('wallet-sheet') || event.target.closest('[data-close]')) $('wallet-sheet').close();
});
$('wallet-sheet').addEventListener('close', () => statusAt((el) => $('wallet').before(el)));
$('top-up').addEventListener('click', () => faucet());
$('copy-address').addEventListener('click', () => copy(state.account?.address ?? '', $('copy-address')));
$('sign-out').addEventListener('click', () => {
  $('wallet-sheet').close();
  logout();
});

// ---- Balances and tier ----

async function refresh() {
  await ensureHealth();
  if (state.account && state.health?.ready) {
    const address = state.account.address;
    const balance = (token) => rpc.readContract({ address: token, abi: Abis.tip20, functionName: 'balanceOf', args: [address] });
    try {
      const [toy, usd, tier] = await Promise.all([balance(state.health.tokens.toy), balance(PATHUSD), api(`/tier/${address}`)]);
      if (state.account?.address === address) Object.assign(state, { toy, usd, tier: tier.tier });
    } catch {}
  }
  await loadMenu();
  render();
}

// ---- Paying for an answer ----

async function paid(path, body) {
  if (!state.mppx || (state.toy < PRICE && state.usd < PRICE)) await refresh();
  if (!state.mppx) throw new Error("Can't reach the agent right now. Try again in a minute.");
  const pay = state.toy >= PRICE ? 'toy' : 'usd';
  if (pay === 'usd' && state.usd < PRICE) {
    throw new Error(state.tier === 'attendee' ? 'You are out of questions for now.' : 'Your balance is used up. Get $1.00 more below.');
  }
  const res = await state.mppx.fetch(`${API}${path}?pay=${pay}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.detail ?? `The agent answered ${res.status}.`);
  let tx = null;
  try { tx = Receipt.deserialize(res.headers.get('payment-receipt') ?? '').reference ?? null; } catch {}
  return { data, tx };
}

function busy(on, text) {
  state.busy = on;
  render();
  say(text ?? '');
}

function receiptLine(data, tx) {
  const parts = [];
  if (isHash(tx)) parts.push(txLink(tx, 'Paid $0.10'));
  if (isHash(data.refund?.tx)) parts.push(txLink(data.refund.tx, 'refunded'));
  else if (data.refund) parts.push('refund delayed');
  if (data.signature && isAddress(data.signer)) parts.push(`signed by the agent (${short(data.signer)})`);
  return parts.join(' · ');
}

// Progress and errors show next to whatever was used, so they stay in view on phones.
const statusAt = (place) => place($('status'));

// Asks one question and shows the answer inside the card it came from. The
// public card asks for the public answer even when the asker could hear more.
async function ask(question, where) {
  if (!state.account) return openLogin(() => ask(question, where));
  const address = state.account.address;
  statusAt((el) => $(where).before(el));
  busy(true, 'Paying $0.10 and asking…');
  try {
    const { data, tx } = await paid('/ask', where === 'public-answer' ? { question, as: 'public' } : { question });
    if (state.account?.address !== address) return busy(false); // signed out meanwhile: the answer isn't shown to the next person
    const el = $(where);
    el.innerHTML = `<p class="meta">${escape(question)}</p><blockquote class="${data.refused ? 'refused' : ''}">${escape(data.answer)}</blockquote><p class="meta">${receiptLine(data, tx)}</p>`;
    el.hidden = false;
    remember({ kind: 'ask', question, answer: String(data.answer ?? ''), refused: Boolean(data.refused), tx, refunded: Boolean(data.refund), refund: data.refund?.tx ?? null });
    busy(false);
  } catch (error) {
    busy(false);
    say(cancelled(error) ? 'The payment was cancelled.' : error.message, true);
  }
  refresh();
}

$('ask-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (!question) return say('Type a question first.', true);
  ask(question, 'public-answer');
});

// ---- Free questions (forwarded from the Tempo faucet) ----

async function faucet(quiet = false) {
  if (!state.account) return openLogin(() => faucet());
  statusAt((el) => ($('wallet-sheet').open ? $('top-up').after(el) : $('wallet').before(el)));
  if (!quiet) busy(true, 'Getting $1.00 of free questions…');
  const address = state.account.address;
  try {
    const sent = await post('/faucet', { address });
    remember({ kind: 'faucet', tx: sent.tx ?? null });
    busy(false, '$1.00 added: ten questions.');
  } catch (error) {
    if (error.code === 'already_funded') {
      busy(false, 'This account already got its free questions today.');
    } else {
      // The agent's relay is busy or down: ask Tempo's own testnet faucet directly.
      try {
        await rpc.request({ method: 'tempo_fundAddress', params: [address] });
        remember({ kind: 'faucet', tx: null });
        busy(false, 'Free test dollars added from the Tempo faucet.');
      } catch {
        busy(false, error.message);
      }
    }
  }
  await refresh();
}
$('faucet').addEventListener('click', () => faucet());

// ---- Unlocking with a credential (Frontiers: zkPass, or Reclaim) ----

const provider = () => (state.health?.zkpass ? 'zkPass' : 'Reclaim');

$('unlock').addEventListener('click', async () => {
  if ($('credential').value !== 'frontiers' || state.preparing) return;
  if (!state.account) return openLogin(() => $('unlock').click());
  statusAt((el) => $('unlock').after(el));
  if (state.health?.zkpass) return unlockWithZkpass();
  // Reclaim takes two clicks: the first prepares the proof request; the second
  // opens Reclaim straight from the click, so browsers don't block it as a popup.
  if (prepared) {
    const { request, session, url } = prepared;
    prepared = null;
    render();
    request.triggerReclaimFlow().catch(() => {});
    const link = /^https:\/\//.test(url ?? '') ? ` No window? <a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Open Reclaim</a>.` : '';
    $('status').innerHTML = `Sign in to your Frontiers account in the Reclaim window, then come back here.${link}`;
    return waitForProof(session);
  }
  state.preparing = true; // held until the request is ready, whatever renders meanwhile
  render();
  say('Preparing your Reclaim proof…');
  try {
    const address = state.account.address;
    const start = await post('/verify', { address });
    if (start.status === 'verified') { say("You're verified for Frontiers."); return refresh(); }
    const { ReclaimProofRequest } = await import('@reclaimprotocol/js-sdk');
    const request = await ReclaimProofRequest.fromJsonString(start.request);
    if (state.account?.address !== address) return; // signed out meanwhile
    prepared = { session: start.session, url: start.request_url, request };
    say('Ready. Continue to prove your Frontiers registration with Reclaim.');
  } catch (error) {
    say(error.message, true);
  } finally {
    state.preparing = false;
    render();
  }
});

// zkPass: on a computer the TransGate extension runs the proof in one go. On a
// phone the first tap prepares a task and the second opens zkPass's app
// straight from the tap; the page then waits for zkPass's relay.
async function unlockWithZkpass() {
  const address = state.account.address;
  const run = ++unlockRun;
  const stale = () => run !== unlockRun || state.account?.address !== address;
  const ready = prepared?.kind === 'zkpass' ? prepared : null;
  prepared = null;
  state.preparing = true;
  render();
  try {
    let result;
    if (ready) {
      openApp(ready);
      say('Sign in to your Frontiers account in zkPass, then come back here.');
      result = await waitForRelay(ready, { cancelled: stale });
    } else {
      const onPhone = device() !== 'computer';
      if (!onPhone && !(await extensionInstalled())) {
        $('status').innerHTML = `Add <a href="${INSTALL_URL}" target="_blank" rel="noopener noreferrer">zkPass TransGate</a> to Chrome, then tap Unlock again.`;
        return;
      }
      say('Preparing your zkPass proof…');
      const task = await prepareZkpass({ appId: state.health.zkpass.app_id, schemaId: state.health.zkpass.schema_id, address });
      if (stale()) return;
      if (onPhone) {
        prepared = { kind: 'zkpass', ...task };
        return say('Ready. Continue in zkPass to prove your Frontiers registration.');
      }
      say("Sign in to your Frontiers account in the tab zkPass opens. The proof starts once Paradigm knows it's you.");
      result = await runExtension(task, { cancelled: stale });
    }
    if (stale()) return;
    say('Checking your proof…');
    const outcome = await submitProof(address, result, stale);
    if (stale()) return;
    if (outcome.status === 'already_claimed') return say('That Frontiers account was already used.', true);
    if (!outcome.already) remember({ kind: 'grant', tx: outcome.tx ?? null });
    say(outcome.already ? "You're already verified for Frontiers." : outcome.grant_delayed ? 'Verified. Your ten questions are on the way.' : 'Verified: ten questions on the house, and closer answers.');
    await refresh();
  } catch (error) {
    if (!stale()) say(error.message, true);
  } finally {
    if (run === unlockRun) state.preparing = false;
    render();
  }
}

// A proof is worth keeping: if the agent is busy or briefly unreachable, the
// same result is sent again rather than asking for a new proof.
async function submitProof(address, result, stale) {
  const passing = new Set(['rate_limited', 'starting', 'busy', 'internal', undefined]);
  for (let attempt = 1; ; attempt++) {
    try {
      return await post('/verify/zkpass', { address, result });
    } catch (error) {
      if (!passing.has(error.code) || attempt >= 6 || stale()) throw error;
      say('The agent is busy; sending your proof again…');
      await sleep(2500 * attempt);
    }
  }
}

// Polls until the proof lands; a newer poll or a sign-out ends this one.
// An error is shown but polling goes on, since a retry in Reclaim still counts.
async function waitForProof(session) {
  const mine = ++pollId;
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    if (mine !== pollId) return;
    let status;
    try { status = await api(`/verify/${session}`); } catch { continue; }
    if (mine !== pollId) return;
    if (status.status === 'verified') {
      say(status.already ? "You're already verified for Frontiers." : status.grant_delayed ? 'Verified. Your ten questions are on the way.' : 'Verified: ten questions on the house, and closer answers.');
      return refresh();
    }
    if (status.status === 'already_claimed') return say('That Frontiers account was already used.', true);
    if (status.status === 'failed') return say(status.error ?? 'The proof did not verify.', true);
    if (status.error) say(status.error, true);
  }
  if (mine === pollId) say('The proof took too long. Try again.', true);
}

$('credential').addEventListener('change', () => {
  $('locked-answer').hidden = true; // an answer belongs to the credential that got it
  render();
});

// ---- Rendering ----

function questionButton(question, { locked, where }) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'q';
  button.disabled = locked || state.busy;
  button.innerHTML = `<span>${escape(question)}</span><span class="go">${locked ? 'locked' : 'ask · $0.10'}</span>`;
  if (!locked) button.addEventListener('click', () => ask(question, where));
  li.append(button);
  return li;
}

// A question the agent hasn't revealed yet: a bar where its words would be.
function veiledQuestion() {
  const li = document.createElement('li');
  li.innerHTML = '<span class="q veiled"><span class="bar" aria-hidden="true"></span><span class="sr-only">A hidden question</span><span class="go">hidden</span></span>';
  return li;
}

// One payment; a question opens to show the answer that was paid for.
function historyItem(entry) {
  const li = document.createElement('li');
  const when = escape(new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  const what = entry.kind === 'ask' ? escape(entry.question ?? '') : entry.kind === 'grant' ? 'Frontiers: ten questions on the house' : 'Free test dollars';
  const amount = entry.kind === 'ask' ? (entry.refunded ? 'refunded' : '−$0.10') : '+$1.00';
  const links = [txLink(entry.tx, 'Payment'), txLink(entry.refund, 'refund')].filter(Boolean).join(' · ');
  const row = (tag) => `<${tag} class="row"><span class="what">${what}</span><span class="amount">${amount}</span><span class="when">${when}</span></${tag}>`;
  li.innerHTML = entry.kind === 'ask' && typeof entry.answer === 'string'
    ? `<details>${row('summary')}<blockquote class="${entry.refused ? 'refused' : ''}">${escape(entry.answer)}</blockquote>${links ? `<p class="links">${links}</p>` : ''}</details>`
    : `${row('div')}${links ? `<p class="links">${links}</p>` : ''}`;
  return li;
}

function renderWallet() {
  if (!state.account) return;
  const page = `${EXPLORER}/address/${state.account.address}`;
  $('wallet-address').textContent = state.account.address;
  $('wallet-address').href = page;
  $('wallet-explorer').href = page;
  $('wallet-total').textContent = money(state.toy + state.usd);
  $('top-up').disabled = state.busy;
  const items = (local.get(historyKey()) ?? []).slice(0, 20).map(historyItem);
  if (!items.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = 'Nothing yet.';
    items.push(none);
  }
  $('history').replaceChildren(...items);
}

const COUNT = ['', 'One question stays', 'Two questions stay', 'Three questions stay', 'Four questions stay', 'Five questions stay'];

function render() {
  $('account-label').textContent = state.account ? short(state.account.address) : 'login';
  $('account').setAttribute('aria-label', state.account ? `Your account, ${state.account.address}: balance, payments and disconnect` : 'Log in with a passkey');
  $('ask').disabled = state.busy;
  $('faucet').disabled = state.busy;

  // Anyone can ask these.
  $('public-questions').replaceChildren(...state.menu.public.map((q) => questionButton(q, { locked: false, where: 'public-answer' })));

  // The credential card: the chosen credential's questions, locked until held.
  const key = $('credential').value;
  const credential = CREDENTIALS[key];
  const held = key === 'frontiers' && state.tier === 'attendee';
  const questions = key === 'frontiers' ? state.menu.attendee : credential.questions;
  $('locked-card').classList.toggle('unlocked', held);
  $('lock-word').textContent = held ? 'Unlocked for' : 'Locked to';
  $('shackle').setAttribute('d', held ? 'M8 11V8a4 4 0 0 1 7.6-1.8' : 'M8 11V8a4 4 0 0 1 8 0v3');
  const veiled = key === 'frontiers' && !held ? state.hidden.attendee : 0;
  $('locked-questions').replaceChildren(
    ...questions.map((q) => questionButton(q, { locked: !held, where: 'locked-answer' })),
    ...Array.from({ length: veiled }, veiledQuestion),
  );
  const by = provider();
  const lead = veiled ? `${COUNT[veiled] ?? `${veiled} questions stay`} hidden until you prove` : 'Prove';
  const note = key === 'frontiers' ? `${lead} your Paradigm Frontiers 2026 registration with a ${by} zkTLS proof. You also get ten questions on the house.` : credential.note;
  $('credential-note').textContent = held ? '' : note;
  const unlock = $('unlock');
  unlock.hidden = held;
  unlock.textContent = key !== 'frontiers' ? credential.unlock
    : !state.health?.verification ? `Unlock with ${by} (opening soon)`
    : state.preparing && by === 'zkPass' ? 'Waiting for zkPass…'
    : prepared ? `Continue with ${by}` : `Unlock with ${by}`;
  unlock.disabled = state.busy || state.preparing || !credential.live || !state.health?.verification;

  // Top right: what you can spend (all of it test dollars to the visitor), or what you start with.
  const balance = $('balance');
  balance.textContent = state.account ? money(state.toy + state.usd) : '$1.00 to start';
  balance.title = state.account ? 'Test dollars on Tempo testnet' : 'Sign in and get $1.00 of test dollars: ten questions';
  $('wallet').hidden = !state.account || state.toy >= PRICE || state.usd >= PRICE;
  renderWallet();
}

// What to paste into an agent; skill.md tells it how to get an account, free test dollars and pay.
$('agent-prompt').textContent = `Read ${API}/skill.md, then ask agent.charliethompson.eth what books Charlie has read in the last two years.`;
$('copy-prompt').addEventListener('click', () => copy($('agent-prompt').textContent, $('copy-prompt')));

async function start() {
  for (const [id, path] of [['skill', '/skill.md'], ['attest', '/attestation']]) $(id).href = `${API}${path}`;
  render();
  await ensureHealth();
  if (!state.health) say("Can't reach the agent right now.", true);
  else if (!state.health.ready) say('The agent is starting up on Tempo; try again in a minute.');
  await useAccount(local.get('ask:account'));
}
start();
