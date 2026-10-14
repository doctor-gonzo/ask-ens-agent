// A small TransGate client: the parts of zkPass's JS SDK (ISC) this page needs,
// without its web3, TON and QR-code dependencies. On a computer it talks to
// the TransGate extension; on a phone it opens zkPass's App Clip (iOS) or app
// (Android) and polls zkPass's relay for the result. Nothing here is trusted:
// the TEE checks every result's signatures before admitting anyone.
import { keccak256, stringToHex } from 'viem';

const SERVER = 'https://dev.zkpass.org/v1';
const RELAY = `${SERVER}/relay/proof`;
const EXTENSION_ID = 'afkoofjocpbclhnldmmaphappihehpma';

export class ZkpassError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const iPad = () => /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1; // iPadOS Safari says it's a Mac
export const device = () => (/iPhone|iPad|iPod/i.test(navigator.userAgent) || iPad() ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'computer');

// The extension exposes its icon to pages, which is how the SDK detects it.
export async function extensionInstalled() {
  try { return (await fetch(`chrome-extension://${EXTENSION_ID}/images/icon-16.png`)).ok; } catch { return false; }
}

async function zkpassPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // 700 is zkPass's "origin not allowed": proofs start only from the app's registered address.
  if (res.status === 700) throw new ZkpassError('origin', 'zkPass only runs proofs started from agent.charliethompson.eth.link.');
  if (!res.ok) throw new ZkpassError('unavailable', `zkPass answered ${res.status}. Try again in a minute.`);
  return (await res.json())?.info;
}

// Step one, before anything leaves the page: zkPass assigns a task (and a
// validator) for this schema and account.
export async function prepare({ appId, schemaId, address }) {
  const config = await zkpassPost(`${SERVER}/sdk/config`, { app_id: appId });
  if (!config?.schemas?.some((schema) => schema.schema_id === schemaId)) throw new ZkpassError('setup', "zkPass doesn't list this schema for the app.");
  const task = await zkpassPost(`https://${config.task_rpc}`, { token: config.token, schema_id: schemaId, app_id: appId, chain_type: 'evm', debug: false });
  if (!task?.task) throw new ZkpassError('unavailable', "zkPass didn't assign a task. Try again in a minute.");
  const callback = config.callbackUrl || RELAY;
  // Built exactly as the SDK builds it, "/" before &account included.
  const query = `app_id=${appId}&task_id=${task.task}&schema_id=${schemaId}&chain_type=evm&callback_url=${callback}/&account=${address}`;
  return { appId, schemaId, address, task, callback, query };
}

// ---- On a computer: the TransGate extension ----

const unicodeEscaped = (text) => Array.from(text).map((ch) => (ch.codePointAt(0) <= 0x7f ? ch : `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`)).join('');
function valuesOf(json) {
  const values = [];
  (function walk(obj) {
    for (const key in obj) {
      if (!Object.hasOwn(obj, key)) continue;
      if (typeof obj[key] === 'object' && obj[key] !== null) walk(obj[key]);
      else values.push(obj[key]);
    }
  })(json);
  return values.join('');
}

// The SDK's public-fields hash, which the validator signs too.
function hashFields(fields) {
  const data = valuesOf(fields.map((item) => (item && typeof item === 'object' ? (({ str, ...rest }) => rest)(item) : item)));
  return keccak256(stringToHex(data ? unicodeEscaped(data) : '1'));
}

// The result in the SDK's shape.
function resultFrom(message, task, address) {
  const fields = Array.isArray(message.publicFields) ? message.publicFields : [];
  return {
    taskId: message.taskId,
    publicFields: fields,
    allocatorAddress: task.alloc_address,
    publicFieldsHash: hashFields(fields),
    allocatorSignature: task.alloc_signature,
    uHash: message.nullifierHash,
    validatorAddress: task.node_address,
    validatorSignature: message.signature,
    recipient: address,
  };
}

export async function runExtension({ appId, schemaId, address, task }, { cancelled = () => false } = {}) {
  const res = await fetch(`${SERVER}/schema/${encodeURIComponent(schemaId)}`);
  if (!res.ok) throw new ZkpassError('unavailable', "Couldn't load the proof's schema from zkPass.");
  const schema = await res.json();
  const params = { task: task.task, allocatorAddress: task.alloc_address, nodeAddress: task.node_address, nodeHost: task.node_host, nodePK: task.node_pk, signature: task.alloc_signature, ...schema, appid: appId };
  return new Promise((resolve, reject) => {
    const outcomes = {
      NOT_MATCH_REQUIREMENTS: ['not_eligible', 'zkPass found no confirmed Frontiers registration on that Paradigm account.'],
      ILLEGAL_WINDOW_CLOSING: ['cancelled', 'The zkPass tab was closed before the proof finished.'],
      UNEXPECTED_VERIFY_ERROR: ['failed', 'zkPass hit an error. Try again.'],
      INVALID_SCHEMA: ['setup', 'zkPass rejected the proof setup.'],
    };
    const stop = () => { window.removeEventListener('message', onMessage); clearTimeout(timer); clearInterval(watch); };
    const timer = setTimeout(() => { stop(); reject(new ZkpassError('timeout', 'The zkPass proof took too long. Try again.')); }, 10 * 60_000);
    const watch = setInterval(() => { if (cancelled()) { stop(); reject(new ZkpassError('cancelled', 'Stopped waiting for zkPass.')); } }, 1000);
    // Any frame could post a matching message; that's harmless, since the TEE
    // re-checks every result, but only zkPass's own outcomes end the wait.
    function onMessage(event) {
      if (event.data?.id !== params.id) return;
      const type = event.data.type;
      if (type === 'GENERATE_ZKP_SUCCESS') {
        let result; // built before the wait ends, so odd data rejects instead of hanging
        try { result = resultFrom(event.data, task, address); } catch { stop(); return reject(new ZkpassError('failed', 'zkPass sent a result this page could not read. Try again.')); }
        stop();
        resolve(result);
      } else if (typeof type === 'string' && Object.hasOwn(outcomes, type)) { stop(); reject(new ZkpassError(...outcomes[type])); }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'AUTH_ZKPASS', mintAccount: address, ...params }, '*');
  });
}

// ---- On a phone (or by QR from a computer): zkPass's App Clip or app, then its relay ----

// What a computer without the extension shows as a QR code, as zkPass's SDK does.
export const handoffUrl = ({ query }) => `https://app.zkpass.org/verify?${query}`;

// Opens zkPass from a tap (a link click, so the phone lets it through).
export function openApp({ query }) {
  const link = document.createElement('a');
  const web = `https://app.zkpass.org/verify?${query}`;
  link.href = device() === 'ios'
    ? `https://appclip.apple.com/id?p=com.zkpass.transgate.clip&${query}`
    : `intent://zkpass.com/verify?${query}#Intent;scheme=zkpass;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

export async function waitForRelay({ callback, task, address }, { cancelled = () => false } = {}) {
  for (let i = 0; i < 300; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (cancelled()) throw new ZkpassError('cancelled', 'Stopped waiting for zkPass.');
    try {
      const res = await fetch(`${callback}?task_index=${encodeURIComponent(task.task)}`, { signal: AbortSignal.timeout(5000) });
      const info = res.ok ? (await res.json())?.info : null;
      if (info && typeof info === 'object') {
        // The relay's record should already be in the SDK's shape; anything
        // missing is filled in as the SDK would, and the TEE checks it all.
        const fields = Array.isArray(info.publicFields) ? info.publicFields : [];
        return { ...info, recipient: info.recipient ?? address, publicFieldsHash: info.publicFieldsHash ?? hashFields(fields) };
      }
    } catch {}
  }
  throw new ZkpassError('timeout', 'The zkPass proof took too long. Try again.');
}
