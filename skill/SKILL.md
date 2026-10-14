---
name: ask-agent-charliethompson-eth
description: Ask agent.charliethompson.eth (Charlie Thompson's personal agent) a question, paying test dollars on Tempo testnet, or read Charlie's website as one Markdown file to compare with your user. Covers making a Tempo testnet account and getting free test dollars first.
---

# Ask agent.charliethompson.eth

Charlie's agent runs in a TEE and answers only from facts Charlie approved
and his public website. Questions are paid in test dollars on Tempo testnet
(no real money) with MPP over HTTP 402: 0.10 for one from the menu
(`/questions`), 0.25 for one of your own. If it can't answer, it says "I can't
share that." and refunds you.

## Comparing your user with Charlie

To answer something like "what overlap is there between my work and
interests and Charlie's?", read Charlie's public website as one Markdown file
(free):

```bash
curl {{API}}/site.md
```

Then compare it with what you already know about your user, on your side.
Don't send your user's details to the agent. Ask the agent (below) only about
something the site doesn't cover.

API: `{{API}}`

## 1. Get a Tempo testnet account

Let mppx make one (the key goes in your OS keychain):

```bash
npx -y mppx@0.13.4 account create --network testnet
npx -y mppx@0.13.4 account view            # prints its address
```

Or use a fresh throwaway testnet key, never one that holds real funds:
`export MPPX_PRIVATE_KEY=0x…`.

## 2. Get free test dollars

```bash
npx -y mppx@0.13.4 account fund --network testnet
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

Ask, paying automatically (0.10 for a menu question, 0.25 for your own):

```bash
npx -y mppx@0.13.4 {{API}}/ask --network testnet -J '{"question":"What books have you read in the last two years?"}'
```

The reply is JSON with these fields:

- `answer`
- `refused`
- `tier`
- `refund`, when the question was refused
- `signer`, `signature` and `statement`

The agent's key signs every statement as an Ethereum personal-sign message. Check the signature with any verifier (viem's `verifyMessage`, for example), and check that `signer` is the `agent` in `{{API}}/attestation`; a signature alone only proves that someone signed.

## Notes

- **Frontiers attendees:** people registered for Paradigm Frontiers 2026 can prove it with zkPass at https://agent.charliethompson.eth.link. That gives ten free questions and closer answers; the paying address sets the tier.
- **Attestation:** `{{API}}/attestation` is a TDX quote that binds the agent's key.
- **Privacy:** don't put personal details about anyone in a question.
