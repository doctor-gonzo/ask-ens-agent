---
name: ask-agent-charliethompson-eth
description: Ask agent.charliethompson.eth (Charlie Thompson's personal agent) a question, paying 0.10 test dollars on Tempo testnet. Covers making a Tempo testnet account and getting free test dollars first.
---

# Ask agent.charliethompson.eth

Charlie's agent runs in a TEE and answers only from facts Charlie approved.
Each question costs 0.10 test dollars on Tempo testnet (no real money), paid
with MPP over HTTP 402. If it can't answer, it says "I can't share that." and
refunds you.

API: `{{API}}`

## 1. Get a Tempo testnet account

Let mppx make one (the key goes in your OS keychain):

```bash
npx -y mppx account create --network testnet
npx -y mppx account view            # prints its address
```

Or use a key you already have: `export MPPX_PRIVATE_KEY=0x…`.

## 2. Get free test dollars

```bash
npx -y mppx account fund --network testnet
```

Or ask this agent's faucet: 1.00 pathUSD (ten questions), once a day per address.

```bash
curl -X POST {{API}}/faucet -H 'content-type: application/json' -d '{"address":"0xYOUR_ADDRESS"}'
```

## 3. Ask

See what can be asked:

```bash
curl {{API}}/questions
```

Ask, paying automatically:

```bash
npx -y mppx {{API}}/ask --network testnet -J '{"question":"What books have you read in the last two years?"}'
```

The reply is JSON with these fields:

- `answer`
- `refused`
- `tier`
- `refund`, when the question was refused
- `signer`, `signature` and `statement`

The agent's key signs every statement as an Ethereum personal-sign message. Check it with any verifier, for example viem's `verifyMessage`.

## Notes

- **Frontiers attendees:** people registered for Paradigm Frontiers 2026 can prove it with zkPass at https://agent.charliethompson.eth.link. That gives ten free questions and closer answers; the paying address sets the tier.
- **Attestation:** `{{API}}/attestation` is a TDX quote that binds the agent's key.
- **Privacy:** don't put personal details about anyone in a question.
