// The agent's Tempo key and the service's secrets. Inside a Phala CVM they
// are derived by the dstack guest agent from the app's identity, so they never
// leave the TEE and survive restarts. Locally they are random and kept in
// DATA_DIR/keys.json (git-ignored, owner-only).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DSTACK_SOCKET = '/var/run/dstack.sock';
const NAMES = ['agent', 'mpp', 'nullifier'];

const toHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

export async function loadKeys({ dataDir, inTee = existsSync(DSTACK_SOCKET) }) {
  if (inTee) {
    const { DstackClient } = await import('@phala/dstack-sdk');
    const client = new DstackClient();
    const keys = {};
    for (const name of NAMES) keys[name] = toHex((await client.getKey(`ask-ens-agent/${name}`, 'v1')).key);
    return { ...keys, inTee: true };
  }
  // In production a missing dstack socket must stop the service, not quietly
  // swap in keys kept on disk.
  if (process.env.REQUIRE_TEE === '1') throw new Error('REQUIRE_TEE=1, but the dstack guest agent is not available');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'keys.json');
  const keys = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let changed = false;
  for (const name of NAMES) {
    if (!/^0x[0-9a-f]{64}$/.test(keys[name] ?? '')) { keys[name] = toHex(randomBytes(32)); changed = true; }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return { ...keys, inTee: false };
}
