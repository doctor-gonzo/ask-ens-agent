# Ask agent.charliethompson.eth

People ask Charlie's personal agent a question and pay a dime on Tempo
testnet. The agent runs in a TEE and answers only from facts Charlie
approved, after a leak check; refusals are refunded. Paradigm Frontiers 2026
attendees prove their registration with a zkPass zkTLS proof for ten free
questions and closer answers, such as where Charlie is.

The design and its decisions are in [docs/plan.md](docs/plan.md).

## How it fits together

- **ENS:** `agent.charliethompson.eth` points to the web app (contenthash, on
  IPFS) and to the agent (ENSIP-26 text records).
- **Website:** people's own questions are also answered from charliethompson.lol,
  read live from the Markdown copies it publishes, and agents can fetch it whole
  at `/site.md`.
- **Tempo:** payments use MPP (`mppx`). The agent sponsors gas, owns a toy
  token (TOY) that can only be sent to it, and forwards free test dollars.
- **TEE:** the service runs in a Phala dstack container; the agent's key is
  derived inside it. Answers come from Phala Confidential AI.
- **zkPass:** a zkTLS proof that Paradigm's `api/frontiers-2026/status` says
  `"confirmed"` for the signed-in account, whatever sign-in method the person
  used. TransGate (Chrome extension, iOS App Clip or Android app) makes it; the
  TEE checks zkPass's signatures, the schema and the asker's address. The
  schema is [docs/zkpass-schema.json](docs/zkpass-schema.json); its id and the
  app id are public and pinned in `enclave/docker-compose.yml`. The Reclaim
  path stays in place for when Reclaim's provider builder works.

## Run locally

Node 22.12+ (via nvm). Everything runs on Tempo testnet; there is no real money.

```sh
npm install
npm test                      # offline checks
npm run dev:api               # the service on :8790, sample facts, a stand-in model
node scripts/build-app.mjs --serve   # the web app on :5173
```

On localhost the app offers a throwaway test key instead of a passkey.
`node scripts/dev-attendee.mjs 0x…` marks an address as a verified attendee
(stop the service first). Agents can ask with the mppx CLI:

```sh
MPPX_PRIVATE_KEY=0x… npx mppx http://localhost:8790/ask --network testnet -J '{"question":"What is his favorite book?"}'
```

## Deploy

1. Push to GitHub; CI builds `ghcr.io/doctor-gonzo/ask-ens-agent`.
2. Pin the digest in `enclave/docker-compose.yml`, with the Reclaim provider
   ID and its exact version string (a range or alias makes every
   verification fail).
3. Deploy to Phala Cloud with `PHALA_CLOUD_API_KEY` set:
   `npx -y phala@1.1.22 deploy -c enclave/docker-compose.yml -e <env file> --wait`.
   The env file holds `PUBLIC_URL`, `CONFIDENTIAL_AI_KEY`, `FACTS_TOKEN`,
   `RECLAIM_APP_ID` and `RECLAIM_APP_SECRET`; it is never committed.
4. Build the app for that service (`API_URL=https://… node scripts/build-app.mjs`),
   pin `dist/app` to IPFS, and set the ENS records below.

## ENS records for agent.charliethompson.eth

| Record | Value |
| --- | --- |
| contenthash | `ipfs://<CID of dist/app>` |
| `agent-endpoint[web]` | `https://agent.charliethompson.eth.link` |
| `agent-endpoint[mcp]` | none yet; agents use the HTTP API below |
| `agent-context` | `Charlie Thompson's personal agent. Ask with MPP on Tempo testnet: POST <PUBLIC_URL>/ask {"question": …}, 0.10 pathUSD. Instructions: <PUBLIC_URL>/skill.md` |
| `url` | `<PUBLIC_URL>/skill.md` |

## Approved facts

The real `facts.yaml` lives in a private repo; `samples/facts.yaml` shows the
format. Each fact names the lowest tier allowed to hear it (`public` or
`attendee`), and `location` has one value per tier. A fact may also have a
`question` (up to 120 characters), which the page lists as something that
tier can ask; it is public even when the answer isn't. Give a public and an
attendee fact the same question ("Where are you?") to show each tier its own
answer. The page only lists facts that have one.
