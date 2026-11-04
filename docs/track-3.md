# Track 3: policy gate, agent loop, web UI

Owner: T3. Files: `src/policy/**`, `src/agent/**`, `src/web/**`, `src/cli.ts`, `data/policy.json`, this doc.

## What it does

- **Policy gate** (`src/policy`): `evaluate(policy, req, ledger, now?)` is a pure function. It denies a request when the amount is invalid, the merchant is not on the allow-list (only `bitrefill`), the category is unknown, the amount is above the per-purchase cap, the daily budget would be exceeded, or the category cap would be exceeded. "Today" means the calendar day in IST. When a request is allowed but above `confirmAboveInr`, it sets `needsHuman`.
- `PolicyGate` wraps `evaluate()` for each run and writes every decision, human click and spend to `data/ledger.jsonl`, which is append-only JSONL and git-ignored. `authorize()` runs **in code** inside `place_order` and `pay_shielded`. It refuses unless the run has an allowed decision, a human "yes" when one was needed, and the same product and amount that were approved. It also re-checks the budget against the ledger as it stands at that moment. The LLM cannot skip it or change it.
- The policy hash is the sha256 of the canonical JSON of `data/policy.json`. Its first 8 hex characters go into every shielded memo as `ZR1|<invoice_id>|<hash8>`.
- `data/policy.json`: ₹1,000 a day, at most ₹1,000 per purchase, a human confirm above ₹500, and Bitrefill only. Category caps are `mobile_topup` ₹600 and `gift_card` ₹1,000.

### Agent (`src/agent`)

`runAgent(prompt, deps)` produces the same six steps in both modes:

| # | Step | Tool |
|---|------|------|
| 1 | search | `search_products` |
| 2 | approve | `request_approval` (the gate) |
| 3 | invoice | `place_order` with `create` |
| 4 | quote | `quote_bridge` |
| 5 | pay | `pay_shielded` (memo set by code) |
| 6 | deliver | `place_order` with `confirm` |

- The gate comes *before* any invoice or payment. This also matches the video shot list.
- `AGENT_MODE=llm`: Claude (`AGENT_MODEL`, default `claude-sonnet-5-5`) drives the 5 tools with a short system prompt. It uses effort `low` and one tool call per turn, with the server-side refusal fallback (`fallbacks: "default"`) turned on. A full run costs about 20k input and 900 output tokens.
- `AGENT_MODE=scripted`: a regex parser (`parse.ts`) handles ₹/Rs/INR/rupees amounts, +91 phone numbers and brands, then calls the same tools in a fixed order.
- Every step's `detail` carries `mode` (real/test/quote/fixture/mock/manual), `ids`, `links` and `summary`. A redemption code goes in `detail.secret`, and the UI masks it.
- Outside `BITREFILL_MODE=real`, the agent shows the matched real product (for example `reliance-jio-india-bundles`) but buys the free test product (`test-phone-refill` or `test-gift-card-code`). The UI says so.

### Dependencies

`deps.ts` `loadAdapters()` dynamically imports `src/wallet/index.ts` (`createWallet`), `src/bitrefill/index.ts` (`createBitrefill`) and `src/bridge/index.ts` (`getBridgeQuote`). If one is missing or fails to load, it falls back to `src/agent/fakes.ts`, which is labelled mock/fixture. Set `ZR_USE_FAKES=1` to force the fakes.

### Web UI (`src/web`)

`bun run serve` listens on PORT, default 3000. It serves:

- `POST /api/run {prompt}` returns `{id}`
- `GET /api/state/:id`
- `GET /api/events/:id` (SSE `state` / `done`)
- `POST /api/confirm/:id {approve}`
- `GET /api/policy`
- `GET /api/runs`

The page is one static `index.html`. It shows a dark 6-step timeline with ids, mode badges and explorer links, a Confirm/Reject card when a human is needed, and a spending-mandate panel with budget and category meters. It also shows the audit log, a legend of the modes, and redemption codes that stay masked until clicked. Adding `?nosse` to the URL with a `#<runId>` gives a static view for screenshots.

## Test commands (all pass, 18:40 IST)

```
bun test src/policy src/agent            # 40 pass, 0 fail
AGENT_MODE=scripted BITREFILL_MODE=offline ZEC_WALLET=mock bun run demo -- "Recharge +919999999999 with ₹239 Jio"
#  → 6/6 OK: search REAL (live guest MCP), gate REAL, invoice FIXTURE, quote QUOTE (live 1Click dry), pay MOCK, deliver FIXTURE
AGENT_MODE=llm ... bun run demo -- --yes "₹700 Amazon Pay gift card for my mom"   # human-confirm path, 6/6 OK
AGENT_MODE=llm ... bun run demo -- "Rs 300 Flipkart voucher"                      # denied (over budget), model stops
bun run serve   # then open http://localhost:3000 and click the "₹700 Amazon Pay" preset → Confirm card
```

### CLI flags

- `--yes` / `--no` answer the confirm prompt. A TTY asks interactively; anything else rejects.
- `--json` prints the full run.
- `--reset-ledger` is an operator action. It archives `data/ledger.jsonl` so the daily budget starts fresh before recording.

Env knobs:

- `LEDGER_PATH`, `POLICY_PATH`
- `INR_PER_USD` (default 84)
- `ZEC_TESTNET_SEND_ZAT` (default 100000, which is 0.001 TAZ actually sent on testnet)
- `ZEC_DEST_ADDRESS` (default: the wallet's own address)
- `USDC_RECIPIENT`
- `ORDER_POLL_MS`, `ZEC_CONFIRM_WAIT_MS`, `AGENT_MAX_TURNS`
- `HOST`

## Real vs mocked (T3 parts)

- The policy gate, ledger and hash are real code. The LLM mode was called for real once per path (3 runs, about 47k tokens in total).
- The shielded amount sent is a fixed testnet amount, not the quoted mainnet ZEC. The UI shows both.

## For the integrator / human

- Before recording, run `bun run demo -- --reset-ledger` so the budget shows ₹1,000.
- For the video:
  1. Run the ₹239 Jio preset (auto-approved).
  2. Run the ₹700 Amazon Pay preset (Confirm card, then click Confirm).
  3. Run the ₹1,500 Flipkart preset (denied: above the per-purchase cap).
- With the real wallet: set `ZEC_WALLET=zecli`. The pay step then shows mode `test` and an explorer link. A confirmation watcher updates the step once the transaction is mined.
