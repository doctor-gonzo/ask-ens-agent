// Local development only: marks an address as a verified attendee and mints
// it the attendee grant, as a passed Reclaim proof would. Stop the local
// service first (it owns the store while running).
//   node scripts/dev-attendee.mjs 0x…
import { getAddress } from 'viem';
import { GRANT_UNITS } from '../lib/config.mjs';
import { loadKeys } from '../lib/keys.mjs';
import { openStore } from '../lib/store.mjs';
import { createTempo } from '../lib/tempo.mjs';

const address = getAddress(process.argv[2]);
const dataDir = process.env.DATA_DIR ?? '.data';
const store = openStore(dataDir);
if (!store.data.token?.token) throw new Error('Run the service once first, so the toy token exists.');
const tempo = createTempo({ privateKey: (await loadKeys({ dataDir, inTee: false })).agent });
store.update((data) => { data.attendees[address] = { verified_at: Date.now(), dev: true }; });
console.log('attendee', address, 'mint', await tempo.mint(store.data.token.token, address, GRANT_UNITS));
