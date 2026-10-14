// Frontiers attendance through Reclaim (zkTLS). The provider proves the
// signed-in page paradigm.xyz/frontiers-2026/account, whose server-rendered
// data includes status:"confirmed" and a session with the account's sign-in
// method, Tempo address or email. Only the page state matters, so any
// sign-in method works. The identity is used once, for a keyed hash that
// allows one claim per Frontiers account, and is never stored.
import { createHmac } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 60_000;

export function reclaimConfig(env) {
  return {
    appId: env.RECLAIM_APP_ID,
    appSecret: env.RECLAIM_APP_SECRET,
    providerId: env.RECLAIM_PROVIDER_ID,
    providerVersion: env.RECLAIM_PROVIDER_VERSION,
    requireTee: env.RECLAIM_REQUIRE_TEE === '1',
    // A provider built by Reclaim's AI has no request hashes to check content against.
    aiProvider: env.RECLAIM_AI_PROVIDER === '1',
    get ready() { return Boolean(this.appId && this.appSecret && this.providerId && this.providerVersion); },
  };
}

// Opens a proof request bound to one session and one Tempo address. The
// browser receives the request's JSON (no secret in it) and runs the flow:
// the Reclaim extension if installed, otherwise Reclaim's remote browser.
export async function startProof({ config, session, address, callbackUrl }) {
  const { ReclaimProofRequest } = await import('@reclaimprotocol/js-sdk');
  // The web portal, never an app: visitors stay in their browser.
  const request = await ReclaimProofRequest.init(config.appId, config.appSecret, config.providerId, { providerVersion: config.providerVersion, acceptAiProviders: config.aiProvider, useAppClip: false });
  if (request.getProviderVersion().providerVersion !== config.providerVersion) throw new Error('Reclaim did not open the pinned provider version');
  request.setAppCallbackUrl(callbackUrl, true);
  request.setJsonContext({ ask_session: session, address });
  return { reclaimSession: request.getSessionId(), requestJson: request.toJsonString(), requestUrl: await request.getRequestUrl() };
}

// Checks a posted proof: signatures and the pinned provider (verifyProof),
// the session and address it was opened for, and the page state.
export async function checkProof({ config, proof, pending, session }) {
  const { verifyProof } = await import('@reclaimprotocol/js-sdk');
  // An AI provider's proofs are checked for signatures only here, and their
  // content by aiAttendee below; a hand-built provider is checked by hash.
  const content = config.aiProvider
    ? { dangerouslyDisableContentValidation: true }
    : { providerId: config.providerId, providerVersion: config.providerVersion, allowedTags: [] };
  const result = await verifyProof(proof, { ...content, ...(config.requireTee ? { teeAttestation: { appSecret: config.appSecret } } : {}) });
  const data = result.data?.[0];
  if (!result.isVerified || data?.context?.reclaimSessionId !== pending.reclaim_session || data?.context?.ask_session !== session || data?.context?.address !== pending.address) {
    return { ok: false, error: 'The proof did not verify.' };
  }
  if (!config.aiProvider) return attendeeFrom(data.extractedParameters ?? {});
  let parameters = {};
  try { parameters = JSON.parse(proof.claimData?.parameters ?? '{}'); } catch {}
  return aiAttendee({ parameters, extracted: data.extractedParameters ?? {}, address: pending.address });
}

// What an AI provider's signed claim must show: it was made on a Frontiers
// page of www.paradigm.xyz, and what the response had to contain (or what was
// extracted from it) says the registration is confirmed, never "not". The
// identity is the email if one was extracted, otherwise the Tempo account.
const CONFIRMED = /"?status"?\s*[:=]\s*"?confirmed|\bstatus\b[^.\n]{0,40}\bconfirmed\b|frontiers 2026 registered|\bregistration (is )?confirmed\b/i;
const NEGATED = /\b(not|un)\s*(yet\s*)?(registered|confirmed)/i;
export function aiAttendee({ parameters, extracted = {}, address }) {
  const fail = (error) => ({ ok: false, error });
  let url;
  try { url = new URL(String(parameters?.url ?? '')); } catch { return fail('The proof is not for a Paradigm page.'); }
  if (url.protocol !== 'https:' || !['www.paradigm.xyz', 'paradigm.xyz'].includes(url.hostname) || !/^\/(api\/)?frontiers-2026(\/|$)/.test(url.pathname)) {
    return fail('The proof is not for your Paradigm Frontiers page.');
  }
  // An inverted match proves the text was absent, so it is never evidence.
  const matches = Array.isArray(parameters.responseMatches) ? parameters.responseMatches.filter((m) => !m?.invert).map((m) => m?.value) : [];
  const evidence = [...matches, ...Object.entries(extracted).map(([k, v]) => `${k}: ${v}`)].filter((v) => typeof v === 'string');
  const confirmed = String(extracted.status ?? '').trim().toLowerCase() === 'confirmed' || evidence.some((v) => CONFIRMED.test(v) && !NEGATED.test(v));
  if (!confirmed) return fail('The proof does not show a confirmed Frontiers registration.');
  const email = Object.entries(extracted).find(([k, v]) => /email/i.test(k) && typeof v === 'string' && v.includes('@'))?.[1];
  return { ok: true, identity: email ? `email:${email.trim().toLowerCase()}` : `account:${String(address).toLowerCase()}` };
}

// For the logs when a claim is turned down: its shape, never its values.
export function claimShape(proof) {
  try {
    const p = JSON.parse(proof?.claimData?.parameters ?? '{}');
    const url = new URL(String(p.url ?? ''));
    return { host: url.hostname, path: url.pathname, keys: Object.keys(p), matches: (p.responseMatches ?? []).map((m) => `${m?.type}:${String(m?.value ?? '').length}ch`) };
  } catch { return { unreadable: true }; }
}

// The provider's extracted parameters: status, and the session's address or
// email (whichever the sign-in method filled in).
export function attendeeFrom(params) {
  if (String(params.status ?? '') !== 'confirmed') return { ok: false, error: 'Your Frontiers registration is not confirmed.' };
  const address = String(params.address ?? '').replace(/"/g, '');
  const email = String(params.email ?? '').replace(/"/g, '').trim().toLowerCase();
  const identity = /^0x[0-9a-fA-F]{40}$/.test(address) ? `address:${address.toLowerCase()}` : email.includes('@') ? `email:${email}` : null;
  if (!identity) return { ok: false, error: 'The proof did not include the account.' };
  return { ok: true, identity };
}

export const claimKey = (secret, identity) => createHmac('sha256', Buffer.from(secret.slice(2), 'hex')).update(identity).digest('hex');
