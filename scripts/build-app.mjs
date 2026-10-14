// Builds the static web app into dist/app (relative paths only, so it works
// from IPFS behind the ENS name). API_URL is the agent service it talks to.
//   API_URL=https://… node scripts/build-app.mjs          one build
//   node scripts/build-app.mjs --serve                     rebuild and serve on :5173
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const serve = process.argv.includes('--serve');
const api = process.env.API_URL ?? 'http://localhost:8790';
const out = 'dist/app';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function copyStaticFiles() {
  for (const file of ['index.html', 'manifest.webmanifest', 'icon.svg']) copyFileSync(`app/${file}`, `${out}/${file}`);
  if (existsSync('app/logos')) cpSync('app/logos', `${out}/logos`, { recursive: true });
  writeFileSync(`${out}/config.js`, `window.ASK_CONFIG = ${JSON.stringify({ api })};\n`);
}
const copyStatic = { name: 'static', setup: (build) => build.onEnd(copyStaticFiles) };

const ctx = await esbuild.context({
  entryPoints: { main: 'app/src/main.js', style: 'app/style.css' },
  outdir: `${out}/js`,
  bundle: true,
  format: 'esm',
  splitting: true,
  target: 'es2022',
  minify: !serve,
  sourcemap: serve,
  loader: { '.woff2': 'file' },
  // The Reclaim SDK is written for Node too; these two are all it needs in a browser.
  alias: { assert: './app/shims/assert.js', crypto: './app/shims/crypto.js' },
  assetNames: 'assets/[name]-[hash]',
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  plugins: [copyStatic],
  logLevel: 'info',
});

if (serve) {
  await ctx.watch();
  // The static files aren't bundled, so esbuild doesn't see them change; copy them here.
  watch('app', { recursive: true }, (event, file) => { if (file && !/^(src|shims)\//.test(file)) copyStaticFiles(); });
  const { port } = await ctx.serve({ servedir: out, host: '127.0.0.1', port: 5173 });
  console.log(`App on http://localhost:${port} (API ${api})`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`Built ${out} for API ${api}`);
}
