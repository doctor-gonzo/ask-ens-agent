// The RPC wrapper, against a stand-in RPC: a sent transaction that the node
// took despite an error is found by its hash instead of failing the payment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, keccak256 } from 'viem';
import { resilientTransport } from '../lib/tempo.mjs';

const RAW = '0x76f8aa0102';
const RECEIPT = { transactionHash: keccak256(RAW), status: '0x1', blockNumber: '0x10' };

function stubRpc(answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    return answer(body);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = () => createClient({ transport: resilientTransport('https://rpc.example', { retryCount: 0, pauseMs: 1 }) });

test('tempo rpc: a payment the node took is found by hash after a 502', async () => {
  const rpc = stubRpc((body) => (body.method === 'eth_sendRawTransactionSync'
    ? new Response('bad gateway', { status: 502 })
    : json({ jsonrpc: '2.0', id: body.id, result: body.params[0] === RECEIPT.transactionHash ? RECEIPT : null })));
  try {
    assert.deepEqual(await client().request({ method: 'eth_sendRawTransactionSync', params: [RAW] }), RECEIPT);
    assert.deepEqual(rpc.calls, ['eth_sendRawTransactionSync', 'eth_getTransactionReceipt']);
  } finally { rpc.restore(); }
});

test('tempo rpc: a transaction the node never took still fails, and other calls are untouched', async () => {
  const rpc = stubRpc((body) => (body.method === 'eth_getTransactionReceipt'
    ? json({ jsonrpc: '2.0', id: body.id, result: null })
    : new Response('bad gateway', { status: 502 })));
  try {
    await assert.rejects(client().request({ method: 'eth_sendRawTransactionSync', params: [RAW] }));
    await assert.rejects(client().request({ method: 'eth_blockNumber', params: [] }));
    assert.equal(rpc.calls.filter((m) => m === 'eth_getTransactionReceipt').length, 8);
  } finally { rpc.restore(); }
});
