// Shared constants: the Tempo testnet, the two accepted tokens and the prices.
// Amounts are in token units; every TIP-20 has 6 decimals.
import { Addresses } from 'viem/tempo';

export const CHAIN_ID = 42431; // Tempo testnet (Moderato)
export const RPC_URL = 'https://rpc.moderato.tempo.xyz';
export const EXPLORER_URL = 'https://explore.testnet.tempo.xyz';

export const PATHUSD = Addresses.pathUsd;
export const TOKEN_FACTORY = Addresses.tip20Factory;
export const POLICY_REGISTRY = Addresses.tip403Registry;
export const ALWAYS_ALLOW = 1n; // built-in TIP-403 policy

export const DECIMALS = 6;
export const PRICE = '0.10'; // one question from the menu, or one location look
export const PRICE_UNITS = 100_000n;
export const OWN_PRICE = '0.25'; // one question of the asker's own, which can draw on the whole website
export const OWN_PRICE_UNITS = 250_000n;
export const GRANT_UNITS = 1_000_000n; // 1.00 = ten questions, from the faucet or for attendees

// The toy token: USD-denominated so one price works for both currencies.
export const TOY = { name: 'Frontiers Toy Dollar', symbol: 'TOY', currency: 'USD', salt: 'ask-ens-agent/TOY/v1' };

export const TIERS = ['public', 'attendee'];
export const DAILY_QUESTIONS = { public: 20, attendee: 40 };
export const MAX_QUESTION_CHARS = 400;
export const REFUSAL = "I can't share that.";
