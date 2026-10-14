// Pins the built web app (dist/app) to IPFS through Pinata and prints its
// CID, which goes in agent.charliethompson.eth's contenthash as ipfs://<CID>.
//   node --env-file=.env scripts/pin-app.mjs      (needs PINATA_JWT)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/app', import.meta.url));
const jwt = process.env.PINATA_JWT;
if (!jwt) throw new Error('Set PINATA_JWT in .env');
// A local build points at a local agent; pinning it would publish a page that can't reach the TEE.
if (/localhost|127\.0\.0\.1/.test(readFileSync(join(root, 'config.js'), 'utf8'))) {
  throw new Error('dist/app is a local build. Rebuild with API_URL=<the TEE URL> node scripts/build-app.mjs first.');
}

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(root);

// Every file sits under one folder, so the folder's CID is the site.
const form = new FormData();
for (const path of files) form.append('file', new Blob([readFileSync(path)]), `app/${relative(root, path)}`);
form.append('pinataMetadata', JSON.stringify({ name: `ask-ens-agent app ${new Date().toISOString()}` }));
form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: form });
if (!res.ok) throw new Error(`Pinata answered ${res.status}`);
const { IpfsHash, PinSize } = await res.json();
console.log(`Pinned ${files.length} files (${PinSize} bytes)`);
console.log(`CID: ${IpfsHash}`);
console.log(`contenthash: ipfs://${IpfsHash}`);
console.log(`Preview: https://${IpfsHash}.ipfs.dweb.link/`);
