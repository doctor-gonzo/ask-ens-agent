// The RPC wrapper, against a stand-in RPC: a payment the node took despite a
// gateway error is found by hash, a rate-limited one is sent again, and the
// node's own rejections (a duplicate, say) stand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, keccak256 } from 'viem';
import { resilientTransport } from '../lib/tempo.mjs';

const RAW = '0x76f8aa0102';
const RECEIPT = { transactionHash: keccak256(RAW), status: '0x1', blockNumber: '0x10' };
const SEND = { method: 'eth_sendRawTransactionSync', params: [RAW] };

function stubRpc(answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    return answer(body, calls);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const result = (body, value) => json({ jsonrpc: '2.0', id: body.id, result: value });
const failure = (body, code, message) => json({ jsonrpc: '2.0', id: body.id, error: { code, message } });
const client = () => createClient({ transport: resilientTransport('https://rpc.example', { retryCount: 0, retryDelay: 1, lookupMs: 40, pauseMs: 5 }) });

test('tempo rpc: a payment the node took is found by hash after a 502', async () => {
  const rpc = stubRpc((body) => (body.method === 'eth_sendRawTransactionSync'
    ? new Response('bad gateway', { status: 502 })
    : result(body, body.params[0] === RECEIPT.transactionHash ? RECEIPT : null)));
  try {
    assert.deepEqual(await client().request(SEND), RECEIPT);
    assert.deepEqual(rpc.calls, ['eth_sendRawTransactionSync', 'eth_getTransactionReceipt']);
  } finally { rpc.restore(); }
});

test('tempo rpc: a rate-limited payment is sent again, as the same transaction', async () => {
  const rpc = stubRpc((body, calls) => (calls.length < 3 ? failure(body, -32005, 'rate limited') : result(body, RECEIPT)));
  try {
    assert.deepEqual(await client().request(SEND), RECEIPT);
    assert.deepEqual(rpc.calls, ['eth_sendRawTransactionSync', 'eth_sendRawTransactionSync', 'eth_sendRawTransactionSync']);
  } finally { rpc.restore(); }
});

test("tempo rpc: the node's own rejection stands, so a replayed duplicate isn't taken for a payment", async () => {
  const rpc = stubRpc((body) => (body.method === 'eth_getTransactionReceipt' ? result(body, RECEIPT) : failure(body, -32000, 'already known')));
  try {
    await assert.rejects(client().request(SEND));
    assert.deepEqual(rpc.calls, ['eth_sendRawTransactionSync']);
  } finally { rpc.restore(); }
});

test('tempo rpc: a transaction the node never took still fails, briefly; other calls are untouched', async () => {
  const rpc = stubRpc((body) => (body.method === 'eth_getTransactionReceipt' ? result(body, null) : new Response('bad gateway', { status: 502 })));
  try {
    const started = Date.now();
    await assert.rejects(client().request(SEND));
    assert.ok(Date.now() - started < 1000);
    assert.ok(rpc.calls.filter((m) => m === 'eth_getTransactionReceipt').length >= 1);
    await assert.rejects(client().request({ method: 'eth_blockNumber', params: [] }));
  } finally { rpc.restore(); }
});
