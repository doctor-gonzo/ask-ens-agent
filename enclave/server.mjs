// Ask ENS Agent: the service behind agent.charliethompson.eth. In production
// it runs in a Phala dstack container (a TEE); locally it is a plain Node
// process with the same code.
//
// Paid routes use MPP on Tempo testnet: the first request gets a 402
// challenge, the client pays and retries, and the payer's address decides
// the tier (public or attendee).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Credential } from 'mppx';
import { Mppx, NodeListener, tempo as mppTempo } from 'mppx/server';
import { getAddress, isAddress } from 'viem';
import { answerQuestion, confidentialModel, fixtureModel } from '../lib/answer.mjs';
import { CHAIN_ID, DAILY_QUESTIONS, EXPLORER_URL, GRANT_UNITS, MAX_QUESTION_CHARS, OWN_PRICE, OWN_PRICE_UNITS, PATHUSD, PRICE, PRICE_UNITS, TOY } from '../lib/config.mjs';
import { capTier, createFactsSource, factsFor, isListed, locationFor, menuFor } from '../lib/facts.mjs';
import { loadKeys } from '../lib/keys.mjs';
import { checkProof, claimKey, reclaimConfig, SESSION_TTL_MS, startProof } from '../lib/reclaim.mjs';
import { createSiteSource } from '../lib/site.mjs';
import { dayOf, openStore } from '../lib/store.mjs';
import { createTempo } from '../lib/tempo.mjs';
import { checkZkpass, zkpassConfig } from '../lib/zkpass.mjs';

const env = process.env;
const PORT = Number(env.PORT ?? 8790);
const HOST = env.HOST ?? '127.0.0.1';
const DATA_DIR = env.DATA_DIR ?? '.data';
const PUBLIC_URL = (env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const DAY_MS = 24 * 60 * 60_000;
const MAX_BODY = 64 * 1024;

const keys = await loadKeys({ dataDir: DATA_DIR });
const store = openStore(DATA_DIR);
const tempo = createTempo({ privateKey: keys.agent, ...(env.TEMPO_RPC_URL ? { rpcUrl: env.TEMPO_RPC_URL } : {}) });
const AGENT = tempo.account.address;
const facts = createFactsSource({ file: env.FACTS_FILE, repo: env.FACTS_REPO, path: env.FACTS_PATH || 'facts.yaml', token: env.FACTS_TOKEN });
const site = createSiteSource(env.SITE_URL ? { base: env.SITE_URL } : {}); // charliethompson.lol, public already
const LISTED = { amount: PRICE, units: PRICE_UNITS };
const OWN = { amount: OWN_PRICE, units: OWN_PRICE_UNITS };
const model = env.MODEL === 'fixture' ? fixtureModel() : confidentialModel({ apiKey: env.CONFIDENTIAL_AI_KEY, ...(env.CONFIDENTIAL_AI_URL ? { baseUrl: env.CONFIDENTIAL_AI_URL } : {}), ...(env.MODEL ? { model: env.MODEL } : {}) });
const zkpass = zkpassConfig(env);
// One proof provider at a time: a Reclaim identity and a zkPass one can't be
// matched, so with both on, one attendee could claim twice. zkPass wins.
const reclaim = zkpass.ready ? { ...reclaimConfig(env), ready: false } : reclaimConfig(env);
const skill = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8');

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const addressOf = (value) => (typeof value === 'string' && value.length === 42 && isAddress(value, { strict: false }) ? getAddress(value) : null);
const tierOf = (address) => (address && store.data.attendees[address] ? 'attendee' : 'public');

// ---- Tempo setup: the faucet float and the toy token, retried until done ----

let toyToken = null;
// One MPP server per accepted token (`?pay=toy` or pathUSD by default): a
// single offer per route keeps the challenge and the payment unambiguous.
let payments = null;
async function setup() {
  for (let attempt = 1; ; attempt++) {
    try {
      await tempo.ensureFloat();
      const token = await tempo.ensureToken(store.data.token);
      store.update((data) => { data.token = token; });
      const server = (currency) => Mppx.create({
        methods: [mppTempo.charge({ testnet: true, currencies: [currency], account: tempo.account, feePayer: true, getClient: () => tempo.client })],
        secretKey: keys.mpp,
        realm: new URL(PUBLIC_URL).host,
      });
      payments = { toy: server(token.token), usd: server(PATHUSD) };
      toyToken = token.token;
      console.log(`Ready: agent ${AGENT}, ${TOY.symbol} ${toyToken}`);
      retryDelayed();
      setInterval(retryDelayed, 2 * 60_000).unref();
      return;
    } catch (error) {
      console.error(`Tempo setup failed (attempt ${attempt}): ${error.shortMessage ?? error.message}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 5000 * attempt)));
    }
  }
}

// Grants and refunds that failed are sent again; each is removed once it goes through.
let retrying = false;
async function retryDelayed() {
  if (retrying || !toyToken) return;
  retrying = true;
  try {
    for (const grant of [...(store.data.failedGrants ?? [])]) {
      try {
        await tempo.mint(toyToken, grant.address, GRANT_UNITS);
        store.update((data) => { data.failedGrants = data.failedGrants.filter((g) => g !== grant); });
      } catch {}
    }
    for (const item of [...(store.data.failedRefunds ?? [])]) {
      try {
        await tempo.refund({ currency: item.currency, toyToken, to: item.payer, amount: BigInt(item.units ?? PRICE_UNITS) });
        store.update((data) => { data.failedRefunds = data.failedRefunds.filter((r) => r !== item); });
      } catch {}
    }
  } finally {
    retrying = false;
  }
}

// ---- Rate limits: overall per-minute caps (a crowd may share one gateway IP) ----

const buckets = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) { buckets.set(key, { count: 1, reset: now + windowMs }); return; }
  if (++bucket.count > max) throw new HttpError(429, 'rate_limited', 'Too many requests; try again soon.');
}
setInterval(() => { const now = Date.now(); for (const [key, b] of buckets) if (b.reset <= now) buckets.delete(key); }, 60_000).unref();

// ---- Paid routes ----

let settling = 0; // payments being settled right now

// The Payment credential, found the way mppx finds it (the Authorization
// header may list several schemes): null if absent, undefined if malformed.
function paymentCredential(request) {
  const scheme = Credential.extractPaymentScheme(request.headers.get('authorization') ?? '');
  if (!scheme) return null;
  try { return Credential.deserialize(scheme); } catch { return undefined; }
}
const payerOf = (credential) => addressOf(String(credential?.source ?? '').split(':').pop());

// Charges `price`, then runs `work` with the payer and the token paid in.
async function paid(request, description, work, price = LISTED) {
  if (!payments) throw new HttpError(503, 'starting', 'The agent is still setting up on Tempo; try again in a minute.');
  // Checked before mppx settles anything, so a turned-away request costs
  // nothing: the payer must be named (it sets the tier and receives refunds).
  const offered = paymentCredential(request);
  if (offered !== null && !payerOf(offered)) throw new HttpError(400, 'no_payer', 'The payment must name the paying account.');
  const pay = new URL(request.url).searchParams.get('pay') === 'toy' ? 'toy' : 'usd';
  // While the cap is full (counting payments still settling), a signed but
  // unsent payment is turned away before it settles. One the payer already
  // sent ("push") is settled and refunded below instead. Only settled payments
  // count toward the cap, so junk requests can't fill it.
  const minute = buckets.get('paid:minute');
  const used = (minute && minute.reset > Date.now() ? minute.count : 0) + settling;
  if (offered?.payload?.type === 'transaction' && used >= 60) throw new HttpError(429, 'busy', 'The agent is busy right now; try again in a minute.');
  if (offered) settling++;
  let result;
  try {
    result = await payments[pay].charge({ amount: price.amount, description })(request.clone());
  } finally {
    if (offered) settling--;
  }
  if (result.status === 402) return result.challenge;
  const credential = paymentCredential(request);
  const payer = payerOf(credential);
  const currency = String(credential?.challenge?.request?.currency ?? '');
  // An overall cap keeps model use bounded however many accounts someone
  // makes. It counts only verified payments, so junk requests can't use it up;
  // a payment over the cap is refunded.
  try {
    limit('paid:minute', 60, 60_000);
  } catch {
    return result.withReceipt(json(200, await signed({ busy: true, refused: true, answer: 'The agent is busy right now; try again in a minute.', refund: await refund(payer, currency, price), at: Date.now() })));
  }
  return result.withReceipt(json(200, await work({ payer, currency })));
}

async function refund(payer, currency, price = LISTED) {
  if (!payer) return null;
  try {
    return { amount: price.amount, tx: await tempo.refund({ currency, toyToken, to: payer, amount: price.units }) };
  } catch (error) {
    console.error(`Refund failed: ${error.shortMessage ?? error.message}`);
    store.update((data) => { (data.failedRefunds ??= []).push({ payer, currency, units: String(price.units), at: Date.now() }); });
    return { amount: price.amount, tx: null, error: 'The refund is delayed.' };
  }
}

// What the agent says is signed by its key, so anyone can check it came from the TEE.
async function signed(body) {
  const statement = JSON.stringify(body);
  return { ...body, signer: AGENT, signature: await tempo.account.signMessage({ message: statement }), statement };
}

async function ask(request) {
  const body = await request.clone().json().catch(() => null);
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION_CHARS) throw new HttpError(400, 'bad_question', `Ask a question of up to ${MAX_QUESTION_CHARS} characters.`);
  // A question from the menu is answered from the approved facts. One of the
  // asker's own also draws on Charlie's website, and costs more.
  const listed = isListed((await facts.get()).facts, question);
  const price = listed ? LISTED : OWN;
  return paid(request, 'One question for agent.charliethompson.eth', async ({ payer, currency }) => {
    const own = tierOf(payer); // sets the daily allowance
    const tier = capTier(own, body?.as); // sets what the answer may draw on
    const day = dayOf();
    const who = payer ?? 'unknown';
    const used = store.data.questions[who]?.day === day ? store.data.questions[who].count : 0;
    if (used >= DAILY_QUESTIONS[own]) {
      return signed({ answer: "That's all the questions for today.", refused: true, tier, refund: await refund(payer, currency, price), at: Date.now() });
    }
    store.update((data) => { data.questions[who] = { day, count: used + 1 }; });
    const { facts: approved } = await facts.get();
    const pages = listed ? [] : (await site.get()).facts;
    const result = await answerQuestion({ question, facts: factsFor([...approved, ...pages], tier), model });
    const refunded = result.refused ? await refund(payer, currency, price) : null;
    console.log(`ask: tier=${tier} refused=${result.refused}${result.reason ? ` reason=${result.reason}` : ''}`);
    return signed({ question_sha256: sha256(question), answer: result.answer, refused: result.refused, tier, price: price.amount, refund: refunded, ai_receipt: result.receipt ?? null, at: Date.now() });
  }, price);
}

async function location(request) {
  return paid(request, 'Where Charlie is', async ({ payer, currency }) => {
    const tier = tierOf(payer);
    const place = locationFor((await facts.get()).location, tier);
    if (!place) return signed({ location: null, tier, refund: await refund(payer, currency), at: Date.now() });
    return signed({ location: place, tier, at: Date.now() });
  });
}

// ---- Free money: forwarded from the agent's faucet-funded balance ----

// Limits are per account plus one overall cap: behind Phala's gateway every
// visitor may share the same IP, so per-IP limits would throttle everyone.
const funding = new Set();
async function faucet(request) {
  const address = addressOf((await request.json().catch(() => null))?.address);
  if (!address) throw new HttpError(400, 'bad_address', 'Send { "address": "0x…" }.');
  if (!toyToken) throw new HttpError(503, 'starting', 'The agent is still setting up on Tempo; try again in a minute.');
  const last = store.data.faucet[address] ?? 0;
  if (Date.now() - last < DAY_MS) throw new HttpError(429, 'already_funded', 'This account already got its free questions today.', { retry_at: last + DAY_MS });
  if (funding.has(address)) throw new HttpError(409, 'in_progress', 'Already sending.');
  limit('faucet:all', 30, 60_000);
  funding.add(address);
  try {
    await tempo.ensureFloat();
    if ((await tempo.balanceOf(PATHUSD, AGENT)) < GRANT_UNITS) throw new HttpError(503, 'faucet_empty', 'The free questions ran out for a moment; try again soon.');
    const tx = await tempo.send(PATHUSD, address, GRANT_UNITS);
    store.update((data) => { data.faucet[address] = Date.now(); });
    return json(200, { amount: '1.00', token: PATHUSD, symbol: 'pathUSD', questions: 10, tx });
  } finally {
    funding.delete(address);
  }
}

// ---- Frontiers attendance ----

// Admits an account once its proof checked out: one claim per Frontiers
// identity, and the first admission mints the ten free questions.
async function admit(address, identity) {
  const key = claimKey(keys.nullifier, identity);
  if (store.data.claims[key] && store.data.claims[key] !== address) return { status: 'already_claimed' };
  const already = Boolean(store.data.attendees[address]);
  store.update((data) => { data.claims[key] = address; data.attendees[address] ??= { verified_at: Date.now() }; });
  if (already) return { status: 'verified', already: true };
  let tx = null;
  try {
    tx = await tempo.mint(toyToken, address, GRANT_UNITS);
  } catch (error) {
    console.error(`Attendee grant failed: ${error.shortMessage ?? error.message}`);
    store.update((data) => { (data.failedGrants ??= []).push({ address, at: Date.now() }); });
  }
  return { status: 'verified', tx, ...(tx ? {} : { grant_delayed: true }) };
}

// zkPass: the page hands over TransGate's result, and it is checked here.
async function verifyZkpass(request) {
  const body = await request.json().catch(() => null);
  const address = addressOf(body?.address);
  if (!address) throw new HttpError(400, 'bad_address', 'Send { "address": "0x…", "result": { … } }.');
  if (!zkpass.ready) throw new HttpError(503, 'not_ready', 'Frontiers verification is not set up yet.');
  if (!toyToken) throw new HttpError(503, 'starting', 'The agent is still setting up on Tempo; try again in a minute.');
  if (store.data.attendees[address]) return json(200, { status: 'verified', already: true });
  // The check is two signature recoveries, so junk costs little; the overall
  // cap counts only proofs that check out, so junk can't lock attendees out.
  const outcome = await checkZkpass({ result: body?.result, schemaId: zkpass.schemaId, address })
    .catch(() => ({ ok: false, error: 'The proof could not be checked.' }));
  if (!outcome.ok) throw new HttpError(400, 'not_verified', outcome.error);
  const owner = store.data.claims[claimKey(keys.nullifier, outcome.identity)];
  if (owner) return json(200, owner === address ? { status: 'verified', already: true } : { status: 'already_claimed' }); // a replay can't use up the cap
  limit('admit:all', 30, 60_000);
  return json(200, await admit(address, outcome.identity));
}

// Reclaim: a session per attempt, and Reclaim posts the proof back.

async function verifyStart(request) {
  const address = addressOf((await request.json().catch(() => null))?.address);
  if (!address) throw new HttpError(400, 'bad_address', 'Send { "address": "0x…" }.');
  if (!reclaim.ready) throw new HttpError(503, 'not_ready', 'Frontiers verification is not set up yet.');
  if (!toyToken) throw new HttpError(503, 'starting', 'The agent is still setting up on Tempo; try again in a minute.');
  if (store.data.attendees[address]) return json(200, { status: 'verified' });
  limit('verify:all', 30, 60_000);
  const session = randomBytes(16).toString('hex');
  const { reclaimSession, requestJson, requestUrl } = await startProof({ config: reclaim, session, address, callbackUrl: `${PUBLIC_URL}/proofs/callback?session=${session}` });
  store.update((data) => {
    for (const [key, value] of Object.entries(data.sessions)) if (value.expires_at <= Date.now() && value.status !== 'checking') delete data.sessions[key];
    data.sessions[session] = { address, reclaim_session: reclaimSession, status: 'pending', expires_at: Date.now() + SESSION_TTL_MS };
  });
  return json(200, { session, request: requestJson, request_url: requestUrl });
}

function verifyStatus(session) {
  const entry = store.data.sessions[session];
  if (!entry) throw new HttpError(404, 'not_found', 'No such verification.');
  return json(200, { status: entry.status, ...(entry.error ? { error: entry.error } : {}), ...(entry.tx ? { tx: entry.tx } : {}), ...(entry.grant_delayed ? { grant_delayed: true } : {}), ...(entry.already ? { already: true } : {}) });
}

let checking = 0; // proofs being checked right now

// Reclaim posts JSON (setAppCallbackUrl(url, true)); older clients URL-encode it.
// Only one plain proof of the usual size goes on to the (costly) check: a few
// signatures and witnesses, and a few response matches.
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function parseProof(text) {
  for (const parse of [() => JSON.parse(text), () => JSON.parse(decodeURIComponent(text))]) {
    let value;
    try { value = parse(); } catch { continue; }
    const proof = Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (!isObject(proof) || !Array.isArray(proof.signatures) || proof.signatures.length === 0 || proof.signatures.length > 4) return null;
    if (proof.witnesses !== undefined && (!Array.isArray(proof.witnesses) || proof.witnesses.length > 4)) return null;
    let matches = 0;
    try { matches = JSON.parse(proof.claimData?.parameters ?? '{}').responseMatches?.length ?? 0; } catch { return null; }
    return matches <= 8 ? proof : null;
  }
  return null;
}

async function proofCallback(request, session) {
  if (!reclaim.ready) throw new HttpError(404, 'not_found', 'No such verification.');
  const pending = /^[0-9a-f]{32}$/.test(session ?? '') && store.data.sessions[session];
  if (!pending || pending.status !== 'pending' || pending.expires_at <= Date.now()) throw new HttpError(404, 'not_found', 'No such verification.');
  if (!toyToken) throw new HttpError(503, 'starting', 'The agent is still setting up on Tempo; try again in a minute.');
  pending.status = 'checking'; // claimed before any await, so a second post is turned away
  const finish = (fields) => store.update((data) => { data.sessions[session] = Object.assign(data.sessions[session] ?? pending, fields); });
  const proof = parseProof(await request.text().catch(() => ''));
  if (!proof) { pending.status = 'pending'; throw new HttpError(400, 'no_proof', 'No usable proof was sent.'); }
  // At most eight checks at once; a proof waits up to 20 s for a slot rather than being dropped.
  for (let waited = 0; checking >= 8; waited += 250) {
    if (waited >= 20_000) { pending.status = 'pending'; throw new HttpError(503, 'busy', 'Busy checking other proofs; try again shortly.'); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  checking++;
  // A check that hangs on Reclaim's API gives its slot back after 30 seconds.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 30_000).unref());
  const outcome = await Promise.race([checkProof({ config: reclaim, proof, pending, session }), timeout])
    .catch((error) => ({ ok: false, error: `The proof could not be checked (${error.message}).` }))
    .finally(() => { checking--; });
  // A bad post doesn't close the session at once (anyone who saw the link could
  // spoil it); after three failures it is closed, so checks can't be repeated forever.
  if (!outcome.ok) {
    const failures = (pending.failures ?? 0) + 1;
    finish({ status: failures >= 3 ? 'failed' : 'pending', failures, error: outcome.error });
    throw new HttpError(400, 'not_verified', outcome.error);
  }
  finish({ ...(await admit(pending.address, outcome.identity)), error: undefined });
  return json(200, { ok: true });
}

// ---- Passkeys: public keys only, so a returning visitor can sign in ----

async function savePasskey(request) {
  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || !/^0x[0-9a-fA-F]{128,130}$/.test(publicKey)) throw new HttpError(400, 'bad_passkey', 'Send a credential id and its P-256 public key.');
  limit('passkey:all', 60, 60_000);
  const existing = store.data.passkeys[id];
  if (existing && existing !== publicKey) throw new HttpError(409, 'exists', 'That credential is already registered.');
  if (!existing && Object.keys(store.data.passkeys).length >= 20_000) throw new HttpError(503, 'full', 'Passkey backup is full; this device still works.');
  if (!existing) store.update((data) => { data.passkeys[id] = publicKey; });
  return json(200, { ok: true });
}

// ---- Charlie's website as one Markdown file, for agents ----

async function siteMarkdown() {
  const { markdown } = await site.get();
  if (!markdown) throw new HttpError(503, 'not_ready', "Charlie's site isn't loaded yet; try again in a minute.");
  return new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'max-age=300' } });
}

// ---- The question menu: labels only, and only up to the asker's tier ----

async function questions(forAddress) {
  return json(200, menuFor((await facts.get()).facts, tierOf(addressOf(forAddress))));
}

// ---- Attestation: inside the CVM, a TDX quote over what this agent is ----

async function attestation() {
  const statement = JSON.stringify({ service: 'ask-ens-agent', agent: AGENT, token: toyToken, chain_id: CHAIN_ID, public_url: PUBLIC_URL });
  if (!keys.inTee) return json(200, { tee: false, statement });
  const { DstackClient } = await import('@phala/dstack-sdk');
  const client = new DstackClient();
  const [quote, info] = await Promise.all([client.getQuote(createHash('sha256').update(statement).digest()), client.info()]);
  return json(200, { tee: true, statement, report_data: 'sha256(statement)', quote: quote.quote, event_log: quote.event_log, app_id: info.app_id, compose_hash: info.compose_hash ?? null, how_to_verify: 'Check the quote at https://proof.t16z.com; its report data must equal the SHA-256 of the statement.' });
}

function health() {
  return json(200, {
    ok: true,
    tee: keys.inTee,
    agent: AGENT,
    chain_id: CHAIN_ID,
    explorer: EXPLORER_URL,
    ready: Boolean(payments),
    tokens: { toy: toyToken, toy_symbol: TOY.symbol, pathusd: PATHUSD },
    price: PRICE,
    prices: { listed: PRICE, own: OWN_PRICE },
    site: site.status(),
    free_questions: 10,
    model: model.name,
    facts: facts.status(),
    verification: reclaim.ready || zkpass.ready,
    // zkPass ids are public: the page needs them to start a proof.
    zkpass: zkpass.ready ? { app_id: zkpass.appId, schema_id: zkpass.schemaId } : null,
  });
}

// ---- Routing ----

// No cookies or ambient credentials, so any origin may call; the preflight
// gets back whichever headers it asks for (mppx adds its own, e.g. Accept-Payment).
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept-payment, payment-authorization',
  'access-control-expose-headers': 'www-authenticate, payment-receipt',
  'access-control-max-age': '600',
};

async function route(request) {
  const { pathname, searchParams } = new URL(request.url);
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204 });
  if (method === 'GET' && pathname === '/health') return health();
  if (method === 'GET' && pathname === '/attestation') return attestation();
  if (method === 'GET' && pathname === '/questions') return questions(searchParams.get('for'));
  if (method === 'GET' && pathname === '/site.md') return siteMarkdown();
  if (method === 'GET' && pathname === '/skill.md') return new Response(skill.replaceAll('{{API}}', PUBLIC_URL), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  if (method === 'POST' && pathname === '/ask') return ask(request);
  if (method === 'POST' && pathname === '/location') return location(request);
  if (method === 'POST' && pathname === '/faucet') return faucet(request);
  if (method === 'POST' && pathname === '/verify') return verifyStart(request);
  if (method === 'POST' && pathname === '/verify/zkpass') return verifyZkpass(request);
  if (method === 'GET' && pathname.startsWith('/verify/')) return verifyStatus(pathname.slice(8));
  if (method === 'POST' && pathname === '/proofs/callback') return proofCallback(request, searchParams.get('session'));
  if (method === 'GET' && pathname.startsWith('/tier/')) return json(200, { tier: tierOf(addressOf(pathname.slice(6))) });
  if (method === 'POST' && pathname === '/passkeys') return savePasskey(request);
  if (method === 'GET' && pathname.startsWith('/passkeys/')) {
    const publicKey = store.data.passkeys[pathname.slice(10)];
    if (!publicKey) throw new HttpError(404, 'not_found', 'Unknown passkey.');
    return json(200, { publicKey });
  }
  throw new HttpError(404, 'not_found', 'No such route.');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  let response;
  try {
    const url = new URL(req.url ?? '/', PUBLIC_URL);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    response = await route(new Request(url, { method: req.method, headers, body }));
  } catch (error) {
    if (error instanceof HttpError) response = json(error.status, { error: { code: error.code, message: error.message, ...error.extra } });
    else { console.error(`Unexpected error: ${error.shortMessage ?? error.message}`); response = json(500, { error: { code: 'internal', message: 'Something went wrong.' } }); }
  }
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  const asked = req.headers['access-control-request-headers'];
  if (typeof asked === 'string' && /^[\w\s,-]{1,512}$/.test(asked)) response.headers.set('access-control-allow-headers', asked);
  await NodeListener.sendResponse(res, response);
});

server.listen(PORT, HOST, () => console.log(`ask-ens-agent on ${PUBLIC_URL} (listening ${HOST}:${PORT}, tee=${keys.inTee}, model=${model.name})`));
// A crash mid-check would leave a session stuck; let Reclaim's retry through.
store.update((data) => { for (const entry of Object.values(data.sessions)) if (entry.status === 'checking') entry.status = 'pending'; });
facts.refresh();
site.refresh();
setup();
