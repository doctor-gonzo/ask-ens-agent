// Offline checks for zkPass results: test keys stand in for zkPass's
// allocator and validator, signing exactly what zkPass's SDK verifies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { checkZkpass, zkpassConfig } from '../lib/zkpass.mjs';

const someone = () => privateKeyToAccount(generatePrivateKey());
const digest = (types, values) => ({ raw: keccak256(encodeAbiParameters(parseAbiParameters(types), values)) });

test('zkpass: only a result zkPass assigned, for this schema and this account, counts', async () => {
  const allocator = someone();
  const validator = someone();
  const asker = someone().address;
  const schemaId = 'c7eab8b7d7e44b05b41b613fe548edf5';
  const taskId = '0123456789abcdef0123456789abcdef';
  const uHash = keccak256(stringToHex('attendee@example.com'));
  const publicFieldsHash = keccak256(stringToHex('1')); // what the SDK hashes when there are no public fields
  const make = async ({ schema = schemaId, recipient = asker, signer = validator } = {}) => {
    const task = stringToHex(taskId, { size: 32 });
    const forSchema = stringToHex(schema, { size: 32 });
    return {
      taskId, uHash, publicFieldsHash, recipient, publicFields: [],
      allocatorAddress: allocator.address,
      validatorAddress: validator.address,
      allocatorSignature: await allocator.signMessage({ message: digest('bytes32, bytes32, address', [task, forSchema, validator.address]) }),
      validatorSignature: await signer.signMessage({ message: digest('bytes32, bytes32, bytes32, bytes32, address', [task, forSchema, uHash, publicFieldsHash, recipient]) }),
    };
  };
  const check = (result, address = asker) => checkZkpass({ result, schemaId, address, allocator: allocator.address });

  assert.deepEqual(await check(await make()), { ok: true, identity: `zkpass:${uHash}` });
  assert.deepEqual(await check({ ...(await make()), recipient: asker.toLowerCase() }), { ok: true, identity: `zkpass:${uHash}` });
  assert.equal((await check(await make(), someone().address)).ok, false, 'made for another account');
  assert.equal((await check(await make({ schema: 'ffffffffffffffffffffffffffffffff' }))).ok, false, 'another schema');
  assert.equal((await check(await make({ signer: someone() }))).ok, false, 'signed by a node zkPass did not assign');
  assert.equal((await check({ ...(await make()), uHash: keccak256(stringToHex('other@example.com')) })).ok, false, 'someone else\'s identity');
  assert.equal((await check({ ...(await make()), validatorAddress: someone().address })).ok, false, 'swapped validator');
  assert.equal((await checkZkpass({ result: await make(), schemaId, address: asker })).ok, false, 'zkPass\'s real allocator never signed this');
  for (const junk of [null, 'proof', {}, { taskId: 'x'.repeat(40) }, { ...(await make()), validatorSignature: '0x12' }]) {
    assert.equal((await check(junk)).ok, false);
  }
});

test('zkpass: configured only with an app id and a schema id that fits its signature', () => {
  assert.equal(zkpassConfig({}).ready, false);
  assert.equal(zkpassConfig({ ZKPASS_APP_ID: 'a1b2c3d4-0000-4000-8000-000000000000' }).ready, false);
  assert.equal(zkpassConfig({ ZKPASS_APP_ID: 'a1b2c3d4-0000-4000-8000-000000000000', ZKPASS_SCHEMA_ID: 'c7eab8b7d7e44b05b41b613fe548edf5' }).ready, true);
  assert.equal(zkpassConfig({ ZKPASS_APP_ID: 'a1b2c3d4-0000-4000-8000-000000000000', ZKPASS_SCHEMA_ID: 'x'.repeat(33) }).ready, false);
});
