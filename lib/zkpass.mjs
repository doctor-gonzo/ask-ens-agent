// Frontiers registration through zkPass (TransGate). The visitor's browser runs
// the zkTLS proof with zkPass; the TEE only checks the result it is handed:
// zkPass's allocator assigned the task to a validator, and that validator
// signed the outcome for our schema and the asker's account. The checks
// follow zkPass's JS SDK (ISC), and nothing here calls zkPass.
import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbiParameters, recoverMessageAddress, stringToHex } from 'viem';

// The address zkPass's SDK and docs give for the EVM task allocator.
export const ZKPASS_ALLOCATOR = '0x19a567b3b212a5b35bA0E3B600FbEd5c2eE9083d';

export function zkpassConfig(env) {
  const appId = String(env.ZKPASS_APP_ID ?? '').trim();
  const schemaId = String(env.ZKPASS_SCHEMA_ID ?? '').trim();
  // The schema id is signed as a bytes32, so it must fit in 32 bytes.
  return { appId, schemaId, ready: /^[\w-]{1,64}$/.test(appId) && /^[\w-]{1,32}$/.test(schemaId) };
}

const isHash = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isSignature = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const signedBy = (types, values, signature) =>
  recoverMessageAddress({ message: { raw: keccak256(encodeAbiParameters(parseAbiParameters(types), values)) }, signature });

// `result` is what TransGate returned; `address` is the account asking to be
// admitted. The identity is the per-person hash of the schema's nullifier
// (the Paradigm email), so a person can claim once.
export async function checkZkpass({ result, schemaId, address, allocator = ZKPASS_ALLOCATOR }) {
  const fail = (error) => ({ ok: false, error });
  const r = result && typeof result === 'object' ? result : {};
  if (typeof r.taskId !== 'string' || !/^[\w-]{1,32}$/.test(r.taskId)) return fail('The proof has no zkPass task.');
  if (!isHash(r.uHash) || !isHash(r.publicFieldsHash) || !isSignature(r.allocatorSignature) || !isSignature(r.validatorSignature)) return fail('The proof is incomplete.');
  if (!isAddress(String(r.validatorAddress), { strict: false }) || !isAddress(String(r.recipient), { strict: false })) return fail('The proof is incomplete.');
  if (!same(r.recipient, address)) return fail('This proof was made for another account.');
  const task = stringToHex(r.taskId, { size: 32 });
  const schema = stringToHex(schemaId, { size: 32 });
  const validator = getAddress(r.validatorAddress);
  const assigner = await signedBy('bytes32, bytes32, address', [task, schema, validator], r.allocatorSignature);
  if (!same(assigner, allocator)) return fail("zkPass didn't assign this proof to its validator, or it is for another schema.");
  const signer = await signedBy('bytes32, bytes32, bytes32, bytes32, address', [task, schema, r.uHash, r.publicFieldsHash, getAddress(r.recipient)], r.validatorSignature);
  if (!same(signer, validator)) return fail("The proof wasn't signed by the validator zkPass assigned.");
  return { ok: true, identity: `zkpass:${r.uHash.toLowerCase()}` };
}
