// A small JSON store on the data volume (encrypted inside the CVM). One
// process owns it; every change is written atomically (temp file, rename).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY = () => ({ token: null, attendees: {}, claims: {}, faucet: {}, passkeys: {}, questions: {}, sessions: {} });

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'store.json');
  const data = { ...EMPTY(), ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) };
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    data,
    // Runs `change` on the data and saves it, so callers never forget to.
    update(change) {
      const result = change(data);
      save();
      return result;
    },
  };
}

export const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
