// Exercises the agent's Tempo setup against the live testnet with the local
// development key: faucet float, toy token, transfer policy, a mint.
//   node scripts/testnet-check.mjs
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Abis } from 'viem/tempo';
import { GRANT_UNITS, PATHUSD } from '../lib/config.mjs';
import { loadKeys } from '../lib/keys.mjs';
import { openStore } from '../lib/store.mjs';
import { createTempo } from '../lib/tempo.mjs';

const dataDir = process.env.DATA_DIR ?? '.data';
const keys = await loadKeys({ dataDir, inTee: false });
const store = openStore(dataDir);
const tempo = createTempo({ privateKey: keys.agent });
console.log('agent', tempo.account.address);

console.log('faucet top-up:', await tempo.ensureFloat());
console.log('pathUSD', await tempo.balanceOf(PATHUSD, tempo.account.address));

const token = await tempo.ensureToken(store.data.token);
store.update((data) => { data.token = token; });
console.log('token', token);
const policy = await tempo.client.readContract({ address: token.token, abi: Abis.tip20, functionName: 'transferPolicyId' });
console.log('transfer policy on token', policy);

const visitor = privateKeyToAccount(generatePrivateKey());
console.log('mint to fresh visitor', visitor.address, await tempo.mint(token.token, visitor.address, GRANT_UNITS));
console.log('visitor TOY', await tempo.balanceOf(token.token, visitor.address));
