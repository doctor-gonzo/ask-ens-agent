// Browser stand-in for Node's `crypto`. The Reclaim SDK only uses it in
// server-side checks (which refuse to run in a browser) and as a fallback
// for Web Crypto, which browsers already provide.
export const webcrypto = globalThis.crypto;
export default { webcrypto };
