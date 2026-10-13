// The web app for agent.charliethompson.eth. A passkey is the visitor's Tempo
// account; questions are paid with MPP (Tempo testnet), and the agent sponsors
// the gas. Static files only, so it can live on IPFS behind the ENS name.
import { Receipt } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { WebAuthnP256 as Passkey, PublicKey } from 'ox';
import { bytesToHex, createClient, formatUnits, http, publicActions } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Abis, Account, WebAuthnP256 } from 'viem/tempo';

const API = String(window.ASK_CONFIG?.api ?? '').replace(/\/+$/, '');
const EXPLORER = tempoModerato.blockExplorers.default.url; // the testnet explorer
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const PRICE = 100_000n; // 0.10
const RP_ID = location.hostname;
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
// Passkeys belong to the page's host, so only hosts that are this app's alone
// may create or use them (a shared IPFS gateway origin is not).
const OWN_HOST = LOCAL || /^agent\.charliethompson\.eth\.(link|limo)$/.test(location.hostname);

const $ = (id) => document.getElementById(id);
const rpc = createClient({ chain: tempoModerato, transport: http() }).extend(publicActions);
const state = { health: null, account: null, mppx: null, tier: 'public', toy: 0n, usd: 0n };

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
const money = (units) => Number(formatUnits(units, 6)).toFixed(2);
const isHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const txLink = (hash, text) => (isHash(hash) ? `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener noreferrer">${text}</a>` : '');
const cancelled = (error) => [error, error?.cause, error?.cause?.cause].some((e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError');

// A prepared Reclaim request (first click) and the current status poller.
let prepared = null;
let pollId = 0;

// ---- The agent's health: fetched until it answers and is ready ----

async function ensureHealth() {
  if (state.health?.ready) return state.health;
  try {
    state.health = await api('/health');
  } catch {
    return state.health;
  }
  if (state.health?.ready && state.account && !state.mppx) buildPayments();
  return state.health;
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
  $('frontiers').textContent = "I'm at Frontiers";
  if (saved?.kind === 'test' && !LOCAL) saved = null;
  if (saved?.kind === 'passkey' && !OWN_HOST) saved = null;
  Object.assign(state, { toy: 0n, usd: 0n, tier: 'public', mppx: null });
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
  $('result').hidden = true;
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

$('account').addEventListener('click', () => {
  if (!state.account) return openLogin();
  if (window.confirm('Sign out of this device? Your passkey keeps the account.')) logout();
});

// ---- Balances and tier ----

async function refresh() {
  await ensureHealth();
  if (!state.account || !state.health?.ready) return render();
  const address = state.account.address;
  const balance = (token) => rpc.readContract({ address: token, abi: Abis.tip20, functionName: 'balanceOf', args: [address] });
  try {
    const [toy, usd, tier] = await Promise.all([balance(state.health.tokens.toy), balance(PATHUSD), api(`/tier/${address}`)]);
    if (state.account?.address === address) Object.assign(state, { toy, usd, tier: tier.tier });
  } catch {}
  render();
}

// ---- Paying for an answer ----

async function paid(path, body) {
  if (!state.mppx || (state.toy < PRICE && state.usd < PRICE)) await refresh();
  if (!state.mppx) throw new Error("Can't reach the agent right now. Try again in a minute.");
  const pay = state.toy >= PRICE ? 'toy' : 'usd';
  if (pay === 'usd' && state.usd < PRICE) {
    throw new Error(state.tier === 'attendee' ? 'You are out of questions for now.' : 'You are out of questions. Get ten free ones below.');
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
  for (const id of ['ask', 'where', 'faucet']) $(id).disabled = on;
  say(text ?? '');
}

async function run(text, action) {
  busy(true, text);
  try {
    await action();
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
  if (!state.account) return openLogin(() => $('ask-form').requestSubmit());
  run('Paying 0.10 and asking…', async () => {
    const { data, tx } = await paid('/ask', { question });
    show(`<blockquote class="${data.refused ? 'refused' : ''}">${escape(data.answer)}</blockquote>`, receiptLine(data, tx));
  });
});

$('where').addEventListener('click', () => {
  if (!state.account) return openLogin(() => $('where').click());
  run('Paying 0.10…', async () => {
    const { data, tx } = await paid('/location', {});
    if (data.busy) return show(`<blockquote class="refused">${escape(data.answer)}</blockquote>`, receiptLine(data, tx));
    const place = data.location ? escape(data.location) : null;
    const text = !place ? "Charlie hasn't shared a location." : data.tier === 'attendee' ? `Charlie is at ${place}.` : `Charlie is in ${place}.`;
    const hint = data.tier === 'public' ? '<br>Registered for Frontiers? Prove it to see where he is at the event.' : '';
    show(`<blockquote>${text}</blockquote>`, receiptLine(data, tx) + hint);
  });
});

function receiptLine(data, tx) {
  const parts = [];
  if (isHash(tx)) parts.push(txLink(tx, 'Paid 0.10'));
  if (isHash(data.refund?.tx)) parts.push(txLink(data.refund.tx, 'refunded'));
  else if (data.refund) parts.push('refund delayed');
  if (data.signature && isAddress(data.signer)) parts.push(`signed by the agent (${short(data.signer)})`);
  return parts.join(' · ');
}

function show(html, meta) {
  $('result').innerHTML = `${html}<p class="meta">${meta}</p>`;
  $('result').hidden = false;
}

// ---- Free questions (forwarded from the Tempo faucet) ----

async function faucet(quiet = false) {
  if (!state.account) return openLogin(() => faucet());
  if (!quiet) busy(true, 'Getting ten free questions…');
  const address = state.account.address;
  try {
    await post('/faucet', { address });
    busy(false, 'Ten free questions added.');
  } catch (error) {
    if (error.code === 'already_funded') {
      busy(false, 'This account already got its free questions today.');
    } else {
      // The agent's relay is busy or down: ask Tempo's own testnet faucet directly.
      try {
        await rpc.request({ method: 'tempo_fundAddress', params: [address] });
        busy(false, 'Free test dollars added from the Tempo faucet.');
      } catch {
        busy(false, error.message);
      }
    }
  }
  await refresh();
}
$('faucet').addEventListener('click', () => faucet());

// ---- Frontiers attendance (Reclaim) ----
// Two clicks: the first prepares the proof request; the second opens Reclaim
// straight from the click, so browsers don't block it as a popup.

$('frontiers').addEventListener('click', async () => {
  if (!state.account) return openLogin(() => $('frontiers').click());
  if (prepared) {
    const { request, session, url } = prepared;
    prepared = null;
    $('frontiers').textContent = "I'm at Frontiers";
    request.triggerReclaimFlow().catch(() => {});
    const link = /^https:\/\//.test(url ?? '') ? ` No window? <a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Open Reclaim</a>.` : '';
    $('status').innerHTML = `Sign in to your Frontiers account in the Reclaim window, then come back here.${link}`;
    return waitForProof(session);
  }
  $('frontiers').disabled = true;
  say('Preparing your Reclaim proof…');
  try {
    const address = state.account.address;
    const start = await post('/verify', { address });
    if (start.status === 'verified') { say("You're verified for Frontiers."); return refresh(); }
    const { ReclaimProofRequest } = await import('@reclaimprotocol/js-sdk');
    const request = await ReclaimProofRequest.fromJsonString(start.request);
    if (state.account?.address !== address) return; // signed out meanwhile
    prepared = { session: start.session, url: start.request_url, request };
    $('frontiers').textContent = 'Continue with Reclaim';
    say('Ready. Continue to prove your Frontiers registration with Reclaim.');
  } catch (error) {
    say(error.message, true);
  } finally {
    $('frontiers').disabled = false;
  }
});

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

// ---- Rendering ----

function render() {
  $('account-label').textContent = state.account ? short(state.account.address) : 'login';
  $('account').setAttribute('aria-label', state.account ? `Signed in as ${state.account.address}. Sign out` : 'Log in with a passkey');
  $('wallet').hidden = !state.account;
  if (state.account) {
    const parts = [`${money(state.toy)} TOY`, `${money(state.usd)} pathUSD`, state.tier === 'attendee' ? 'Frontiers attendee' : 'public'];
    $('balances').textContent = parts.join(' · ');
    $('frontiers').hidden = state.tier === 'attendee' || !state.health?.verification;
    $('faucet').hidden = state.toy >= PRICE || state.usd >= PRICE;
    $('wallet').querySelector('.row').hidden = $('frontiers').hidden && $('faucet').hidden;
  }
  $('ask').textContent = 'Ask · 0.10';
}

async function start() {
  for (const [id, path] of [['skill', '/skill.md'], ['attest', '/attestation']]) $(id).href = `${API}${path}`;
  await ensureHealth();
  if (!state.health) say("Can't reach the agent right now.", true);
  else if (!state.health.ready) say('The agent is starting up on Tempo; try again in a minute.');
  await useAccount(local.get('ask:account'));
}
start();
