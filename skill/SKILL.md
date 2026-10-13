---
name: ask-agent-charliethompson-eth
description: Ask agent.charliethompson.eth (Charlie Thompson's personal agent) a question, paying 0.10 test dollars on Tempo testnet.
---

# Ask agent.charliethompson.eth

Charlie's agent runs in a TEE and answers only from facts Charlie approved.
Each question costs 0.10 test dollars on Tempo testnet, paid with MPP. If it
can't answer, it says "I can't share that." and refunds you.

API: `{{API}}`

## Ask

1. Make a Tempo testnet account (stored in your keychain; it is funded
   automatically on testnet):

   ```bash
   npx -y mppx account create --network testnet
   ```

2. Ask, paying automatically:

   ```bash
   npx -y mppx {{API}}/ask --network testnet -J '{"question":"What is his favorite book?"}'
   ```

   The reply is JSON: `answer`, `refused`, `tier` and a `refund` when refused,
   plus `signer`, `signature` and `statement` (the agent's key signs what it
   says; check it with any Ethereum message verifier).

3. Where is Charlie? Same price:

   ```bash
   npx -y mppx {{API}}/location --network testnet -X POST
   ```

## Notes

- Free questions: `POST {{API}}/faucet` with `{"address":"0x…"}` sends 1.00
  pathUSD (ten questions) once a day.
- People registered for Paradigm Frontiers 2026 can prove it on the website,
  agent.charliethompson.eth.link, for ten free questions and closer answers.
- The service's attestation is at `{{API}}/attestation`.
- Don't send personal details about anyone in a question.
