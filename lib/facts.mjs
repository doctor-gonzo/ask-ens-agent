// Charlie's approved facts: the only personal data the agent can reach.
// They come from facts.yaml, either a local file (development) or a private
// GitHub repo read with a read-only token. Each fact names the lowest tier
// allowed to hear it; anything malformed is dropped, never guessed at.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { TIERS } from './config.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function parseFacts(text) {
  const doc = parse(text) ?? {};
  const facts = [];
  const seen = new Set();
  for (const item of Array.isArray(doc.facts) ? doc.facts : []) {
    const id = String(item?.id ?? '');
    const tier = String(item?.tier ?? '');
    const factText = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!ID.test(id) || seen.has(id) || !TIERS.includes(tier) || !factText || factText.length > 500) continue;
    seen.add(id);
    facts.push({ id, tier, text: factText });
  }
  const location = {};
  for (const tier of TIERS) {
    const value = doc.location?.[tier];
    if (typeof value === 'string' && value.trim() && value.length <= 120) location[tier] = value.trim();
  }
  return { facts, location, dropped: (Array.isArray(doc.facts) ? doc.facts.length : 0) - facts.length };
}

// What a tier may hear: its own facts and every lower tier's.
export function factsFor(facts, tier) {
  const rank = TIERS.indexOf(tier);
  return facts.filter((fact) => TIERS.indexOf(fact.tier) <= rank);
}

export function locationFor(location, tier) {
  const rank = TIERS.indexOf(tier);
  for (let i = rank; i >= 0; i--) if (location[TIERS[i]]) return location[TIERS[i]];
  return null;
}

// Keeps the latest good copy; a failed refresh keeps serving the last one and
// is retried after a short pause, never on every request.
export function createFactsSource({ file, repo, path = 'facts.yaml', token, fetchImpl = fetch, refreshMs = 60_000, retryMs = 10_000 }) {
  let current = { facts: [], location: {}, dropped: 0 };
  let loadedAt = 0;
  let attemptedAt = 0;
  let inflight = null;
  let error = null;

  async function read() {
    if (file) return readFile(file, 'utf8');
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`, {
      headers: { accept: 'application/vnd.github.raw+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the facts file`);
    return res.text();
  }

  function refresh() {
    inflight ??= (async () => {
      attemptedAt = Date.now();
      try {
        current = parseFacts(await read());
        loadedAt = Date.now();
        error = null;
      } catch (e) {
        error = e.message;
      }
      return current;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    configured: Boolean(file || (repo && token)),
    async get() {
      if (inflight && !loadedAt) await inflight; // the first load is worth waiting for
      if (Date.now() - attemptedAt > (error ? retryMs : refreshMs)) await refresh();
      return current;
    },
    refresh,
    status: () => ({ facts: current.facts.length, dropped: current.dropped, loaded_at: loadedAt || null, error }),
  };
}
