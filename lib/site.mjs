// Charlie's public website as one Markdown file, read from the Markdown copies
// charliethompson.lol publishes for agents. Agents can fetch it whole
// (/site.md), and the agent answers people's own questions from it: its
// lines become public facts. It is public already, so nothing here is
// secret; a failed refresh keeps the last good copy.
export const SITE_URL = 'https://charliethompson.lol';
export const SITE_PAGES = ['index.html.md', 'thoughts.html.md', 'quantum.html.md', 'zuzalu.html.md', 'pictures.html.md', 'links.html.md'];
const MAX_PAGE = 64 * 1024;
const MAX_CHUNK = 450;
const MAX_CHUNKS = 80;

// Lines as facts: list items and lines are kept whole and grouped up to one
// fact's length; a long line splits only where a sentence ends (a period then
// a space, so never inside a link); a heading stays with the text under it.
export function siteFacts(markdown) {
  const chunks = [];
  let current = '';
  let headingOnly = false;
  const flush = () => { if (current) chunks.push(current); current = ''; headingOnly = false; };
  for (const block of markdown.split(/\n\s*\n/)) {
    if (!headingOnly) flush(); // a block starts a new fact, unless it follows a heading
    for (const line of block.split('\n')) {
      const unit = line.replace(/\s+/g, ' ').trim();
      if (!unit || /^(source:|---|<!--)/i.test(unit)) continue;
      const parts = unit.length <= MAX_CHUNK ? [unit] : unit.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/).map((x) => x.slice(0, MAX_CHUNK));
      for (const part of parts) {
        if (part.startsWith('#')) {
          if (!headingOnly) flush();
          current = current ? `${current} ${part}` : part;
          headingOnly = true;
          continue;
        }
        if (current && current.length + part.length + 1 > MAX_CHUNK) flush();
        current = current ? `${current} ${part}` : part;
        headingOnly = false;
      }
    }
  }
  flush();
  return chunks.slice(0, MAX_CHUNKS).map((text, i) => ({ id: `site-${i + 1}`, tier: 'public', text }));
}

export function createSiteSource({ base = SITE_URL, pages = SITE_PAGES, fetchImpl = fetch, refreshMs = 10 * 60_000, retryMs = 60_000 } = {}) {
  let current = { markdown: '', facts: [] };
  let loadedAt = 0;
  let attemptedAt = 0;
  let inflight = null;
  let error = null;

  async function page(name) {
    const res = await fetchImpl(`${base}/${name}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!res.ok) throw new Error(`${name} answered ${res.status}`);
    const text = await res.text();
    return text.length > MAX_PAGE ? text.slice(0, MAX_PAGE) : text;
  }

  function refresh() {
    inflight ??= (async () => {
      attemptedAt = Date.now();
      try {
        const texts = await Promise.all(pages.map(page));
        const markdown = texts.map((text, i) => `<!-- ${base}/${pages[i]} -->\n\n${text.trim()}\n`).join('\n---\n\n');
        current = { markdown, facts: siteFacts(texts.join('\n\n')) };
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
    async get() {
      if (inflight && !loadedAt) await inflight;
      if (Date.now() - attemptedAt > (error ? retryMs : refreshMs)) await refresh();
      return current;
    },
    refresh,
    status: () => ({ chunks: current.facts.length, bytes: current.markdown.length, loaded_at: loadedAt || null, error }),
  };
}
