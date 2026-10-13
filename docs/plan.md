# Ask ENS Agent: build plan

Decided with the project owner on 13 October 2026, for the Paradigm Frontiers
demos on 14 October. This is the contract the build follows; change it here
first.

People ask `agent.charliethompson.eth` a question and pay a dime on Tempo.
A personal agent in a TEE answers only from facts Charlie approved, after a
leak check. People who prove they're registered for Paradigm Frontiers 2026
get free questions and see more, such as where Charlie is right now.

## Decisions

| Topic | Decision |
| --- | --- |
| Name and site | `agent.charliethompson.eth`. Its contenthash points at the web app on IPFS, served at `https://agent.charliethompson.eth.link`. Charlie signs the ENS records. |
| Network | Tempo testnet (Moderato, chain 42431). No real money. |
| Payments | MPP (`mppx`) Tempo charge: 0.10 per question and 0.10 per location look, in pathUSD (default) or the toy token (`?pay=toy`). One offer per request, because mppx 0.13.4 misroutes payments when one route offers two tokens. The agent sponsors fees, so payers need no gas. The web client signs only 0.10 in one of those two tokens. |
| Toy token | A TIP-20, "Frontiers Toy Dollar" (TOY), USD-denominated so one price works for both currencies. The agent creates and issues it. A TIP-403 compound policy lets anyone send it, but only to the agent, so it can't be traded. Refunds are re-mints. |
| Free money | Anyone with a Tempo account can get 1.00 pathUSD (10 questions) once a day. The agent forwards it from its own balance and refills that from Tempo's faucet (`tempo_fundAddress`). |
| Attendees | A Reclaim zkTLS proof that `paradigm.xyz/frontiers-2026/account` shows `status:"confirmed"`. It checks the page state, not how the person signed in (email, Google or Tempo). The Reclaim browser extension reuses the person's existing session; otherwise Reclaim's remote browser opens from a second click (so it isn't blocked as a popup), with a plain link as a fallback. A proof grants 1.00 TOY (10 questions) and the attendee tier, once per Frontiers account. |
| Tiers | `public` (anyone who pays) and `attendee` (verified Frontiers 2026). The payer's address decides the tier, so identity and payment are the same thing. Friends and SBTs come later; the site says SBTs can represent Reclaim proofs. |
| Approved data | `facts.yaml` in a private GitHub repo, read by the TEE with a read-only token. Each fact names the tier allowed to hear it. Nothing else of Charlie's is reachable. |
| Answers | Phala Confidential AI (GPU TEE). The answering model sees only the facts the asker's tier allows. Because answers are signed, a draft may only use words from the facts it cites; otherwise those facts are sent as written. A second call checks the result without seeing the question, and pattern checks catch emails, phone numbers and street addresses. A refusal is one uniform line and is refunded. |
| Location | A "See location" button, decided in code with no model: `public` gets "San Francisco"; `attendee` gets "Gallery 308, Fort Mason". Both come from `facts.yaml`. |
| Agents | ENSIP-26 text records point at the TEE. Agents pay with the mppx CLI (`npx mppx account create`, then `npx mppx <endpoint>/ask -J '{"question":"…"}'`). Instructions at `/skill.md`. |
| TEE | A Phala dstack CVM. The agent's Tempo key and secrets are derived inside it (`getKey`), so the money and the token's issuer role belong to attested code. |
| Style | The ZK Ads Frontiers theme: ivory `#F5F4EE`, near-black text, acid yellow `#DFFF38` for the main action, serif headlines, sans body, thin rules, square controls. Minimal: as few labels and small print as possible. |
| Code | Its own Git repo inside paradigm-frontiers, like `zkads`. |

## Architecture

```
 visitor (browser)                          another person's agent
   │ passkey → Tempo account                  │ reads ENS records, pays with mppx CLI
   ▼                                          ▼
 agent.charliethompson.eth.link ──────►  TEE service (Phala dstack CVM)
 (static app on IPFS, via ENS              /faucet  /verify  /ask  /location
  contenthash)                             agent key + secrets derived in the TEE
                                               │            │             │
                                  Tempo testnet│   Reclaim  │   Phala      │ facts.yaml
                                  (MPP, TOY,   │   (proof   │   Confidential│ (private
                                   pathUSD)    │   check)   │   AI          │  GitHub repo)
```

## Service API

JSON over HTTPS. Paid routes answer `402` with an MPP challenge first.

| Route | Purpose |
| --- | --- |
| `GET /health` | `tee`, agent address, token address, chain, prices, facts status |
| `GET /attestation` | A TDX quote whose report data binds the agent address and token |
| `POST /faucet` `{ address }` | Forward 1.00 pathUSD, once per address a day |
| `POST /verify` `{ address }` | Start a Reclaim proof for that address: `{ session, request_url }` |
| `GET /verify/:session` | `pending`, `verified`, `already_claimed` or `failed` |
| `POST /proofs/callback?session=` | Reclaim posts the proof; verified here |
| `GET /tier/:address` | `public` or `attendee` |
| `POST /ask` `{ question }` | Paid. `{ answer, refused, refund, tier, signature }` |
| `POST /location` | Paid. `{ location, tier }` |
| `POST /passkeys` · `GET /passkeys/:id` | Keep a passkey's public key so a returning visitor can sign in |
| `GET /skill.md` | How agents ask and pay |

## Approved data

```yaml
facts:
  - id: favorite-book
    tier: public          # public | attendee
    text: Charlie's favorite book is ...
location:
  public: San Francisco
  attendee: Gallery 308, Fort Mason
```

## Privacy and safety

- The model only ever sees the facts the asker's tier allows, so a trick
  question can at worst reveal what that asker could already hear.
- The leak check sees the draft answer and the allowed facts, never the
  question, so the question can't talk it into approving.
- Refusals are identical and refunded. Each address has a daily question cap,
  and overall caps bound model use and the faucet however many accounts
  someone makes (per-IP limits would throttle a crowd behind one gateway).
- The Reclaim proof shows the TEE the account's email or address. The TEE
  keeps only a keyed hash (to allow one claim per account) and discards it.
- Question text is never stored.

## Build order

1. **Service core, locally.** Keys, toy token setup, faucet, MPP-paid `/ask`
   and `/location`, tiers, the answer pipeline with a fixture model, leak
   checks, refunds. Tests run offline; one script exercises the real testnet.
2. **Web app.** Passkey account, balances, free questions, ask, see location,
   the explainer. Checked in a browser against the local service.
3. **Reclaim.** The provider for the Frontiers account page, then
   verification in the service.
4. **Deploy.** Container image, Phala CVM, Confidential AI, the facts repo.
5. **IPFS and ENS.** Pin the app; Charlie sets the contenthash and text
   records.
6. **Agents.** `skill.md` and a rehearsed CLI demo.

Independent reviews (security and correctness) after steps 2 and 3.

## Inputs needed from Charlie, by step

- 3: a Reclaim app ID and secret (into `.env`), and creating the provider in
  Reclaim's developer portal.
- 4: OK to create the GitHub repos (public code, private facts); the Phala
  Cloud API key; the Confidential AI key; a read-only token for the facts
  repo.
- 5: an IPFS pinning service key; signing the ENS records.
