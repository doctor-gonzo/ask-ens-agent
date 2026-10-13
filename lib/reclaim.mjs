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
    get ready() { return Boolean(this.appId && this.appSecret && this.providerId && this.providerVersion); },
  };
}

// Opens a proof request bound to one session and one Tempo address. The
// browser receives the request's JSON (no secret in it) and runs the flow:
// the Reclaim extension if installed, otherwise Reclaim's remote browser.
export async function startProof({ config, session, address, callbackUrl }) {
  const { ReclaimProofRequest } = await import('@reclaimprotocol/js-sdk');
  const request = await ReclaimProofRequest.init(config.appId, config.appSecret, config.providerId, { providerVersion: config.providerVersion });
  if (request.getProviderVersion().providerVersion !== config.providerVersion) throw new Error('Reclaim did not open the pinned provider version');
  request.setAppCallbackUrl(callbackUrl, true);
  request.setJsonContext({ ask_session: session, address });
  return { reclaimSession: request.getSessionId(), requestJson: request.toJsonString(), requestUrl: await request.getRequestUrl() };
}

// Checks a posted proof: signatures and the pinned provider (verifyProof),
// the session and address it was opened for, and the page state.
export async function checkProof({ config, proof, pending, session }) {
  const { verifyProof } = await import('@reclaimprotocol/js-sdk');
  const result = await verifyProof(proof, {
    providerId: config.providerId,
    providerVersion: config.providerVersion,
    allowedTags: [],
    ...(config.requireTee ? { teeAttestation: { appSecret: config.appSecret } } : {}),
  });
  const data = result.data?.[0];
  if (!result.isVerified || data?.context?.reclaimSessionId !== pending.reclaim_session || data?.context?.ask_session !== session || data?.context?.address !== pending.address) {
    return { ok: false, error: 'The proof did not verify.' };
  }
  return attendeeFrom(data.extractedParameters ?? {});
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
