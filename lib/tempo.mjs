// Everything the agent does on Tempo testnet: keep itself funded from the
// faucet, own the toy token, forward free test dollars and pay refunds.
import { createClient, http, keccak256, parseEventLogs, publicActions, stringToHex, walletActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Abis, tempoActions } from 'viem/tempo';
import { ALWAYS_ALLOW, PATHUSD, POLICY_REGISTRY, RPC_URL, TOKEN_FACTORY, TOY } from './config.mjs';

const MIN_FLOAT = 5_000_000n; // refill from the faucet below 5.00 pathUSD

// The public testnet RPC rate-limits bursts, and now and then answers 502
// after it has taken a transaction. More retries, with backoff, cover the
// first (a rate-limited request was never processed). For the second, a sent
// transaction that seems to fail is looked up by its hash before the failure
// counts, so a payment that landed isn't lost.
export function resilientTransport(rpcUrl, { retryCount = 6, retryDelay = 300, lookups = 8, pauseMs = 750 } = {}) {
  const transport = http(rpcUrl, { retryCount, retryDelay });
  return (options) => {
    const base = transport(options);
    return {
      ...base,
      async request(args, opts) {
        try {
          return await base.request(args, opts);
        } catch (error) {
          if (args?.method !== 'eth_sendRawTransactionSync' || typeof args.params?.[0] !== 'string') throw error;
          const hash = keccak256(args.params[0]);
          for (let i = 0; i < lookups; i++) {
            const receipt = await base.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
            if (receipt) return receipt;
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
          }
          throw error;
        }
      },
    };
  };
}

export function createTempo({ privateKey, rpcUrl = RPC_URL }) {
  const account = privateKeyToAccount(privateKey);
  const client = createClient({ account, chain: tempoModerato, transport: resilientTransport(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions)
    .extend(tempoActions());

  const balanceOf = (token, owner) => client.readContract({ address: token, abi: Abis.tip20, functionName: 'balanceOf', args: [owner] });

  // A faucet hiccup is logged, not fatal: whatever balance there is still works.
  async function ensureFloat() {
    if ((await balanceOf(PATHUSD, account.address)) >= MIN_FLOAT) return false;
    try {
      await client.faucet.fundSync({ account: account.address });
      return true;
    } catch (error) {
      console.error(`Faucet top-up failed: ${error.shortMessage ?? error.message}`);
      return false;
    }
  }

  // Creates the toy token on first run; every step is skipped once done, so a
  // restart (or a new data volume) converges on the same token.
  async function ensureToken(saved) {
    const salt = keccak256(stringToHex(TOY.salt));
    const token = await client.readContract({ address: TOKEN_FACTORY, abi: Abis.tip20Factory, functionName: 'getTokenAddress', args: [account.address, salt] });
    const exists = await client.readContract({ address: TOKEN_FACTORY, abi: Abis.tip20Factory, functionName: 'isTIP20', args: [token] });
    if (!exists) await client.token.createSync({ name: TOY.name, symbol: TOY.symbol, currency: TOY.currency, quoteToken: PATHUSD, admin: account.address, salt });
    if (!(await client.token.hasRole({ token, account: account.address, role: 'issuer' }))) {
      await client.token.grantRolesSync({ token, to: account.address, roles: ['issuer'] });
    }
    const current = await client.readContract({ address: token, abi: Abis.tip20, functionName: 'transferPolicyId' });
    if (saved?.token === token && saved.policy && BigInt(saved.policy) === current) return saved;
    // Anyone may send TOY, but only to the agent; the agent may mint to anyone.
    const { policyId: whitelist } = await client.policy.createSync({ admin: account.address, type: 'whitelist', addresses: [account.address] });
    const hash = await client.writeContract({ address: POLICY_REGISTRY, abi: Abis.tip403Registry, functionName: 'createCompoundPolicy', args: [ALWAYS_ALLOW, whitelist, ALWAYS_ALLOW] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: Abis.tip403Registry, eventName: 'CompoundPolicyCreated', logs: receipt.logs });
    if (!created) throw new Error('The compound transfer policy was not created');
    const policy = created.args.policyId;
    await client.token.changeTransferPolicySync({ token, policyId: policy });
    return { token, whitelist: whitelist.toString(), policy: policy.toString() };
  }

  const txHash = (result) => result?.receipt?.transactionHash ?? null;

  // The agent's own transactions go one at a time, so they never race for a nonce.
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const mint = (token, to, amount) => serial(async () => txHash(await client.token.mintSync({ token, to, amount })));
  const send = (token, to, amount) => serial(async () => txHash(await client.token.transferSync({ token, to, amount })));

  return {
    account,
    client,
    balanceOf,
    ensureFloat: () => serial(ensureFloat),
    ensureToken: (saved) => serial(() => ensureToken(saved)),
    mint,
    send,
    // TOY can't be sent back (only the agent may receive it), so it is re-minted.
    refund: ({ currency, toyToken, to, amount }) =>
      currency.toLowerCase() === toyToken.toLowerCase() ? mint(toyToken, to, amount) : send(currency, to, amount),
  };
}
