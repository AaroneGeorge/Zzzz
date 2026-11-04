# Architecture

## Components

| Dir | Role |
|---|---|
| `src/agent` | The loop. `AGENT_MODE=llm` lets Claude pick tool calls; `scripted` parses the request with a regex and calls the same tools in fixed order. Both produce the same seven steps. |
| `src/policy` | `evaluate()` (pure function), `PolicyGate` (stateful wrapper, `authorize()`), `Ledger` (append-only JSONL), policy hash and memo builder. |
| `src/bitrefill` | Client: guest MCP (live search, no key), v2 REST (key), offline fixtures. TOON decoding for MCP results. |
| `src/bridge` | NEAR Intents 1Click **dry** quote, ZEC to USDC on Base. |
| `src/gateway` | The shielded payment gateway: invoice, view-only wallet source (`zingo-source`), memo/amount matcher, polling watcher. See below. |
| `src/wallet` | Wallet interface (`getAddress`, `getBalance`, `send`, `waitConfirmed`, `readMemos`) with adapters `zingo` (zingo-cli in Docker, testnet), `zecli` (addresses only; no public testnet backend), `manual`, `mock`. |
| `src/web` | Bun server plus one static `index.html`: timeline, Confirm card, mandate meters, audit log. Binds `127.0.0.1` unless `HOST` says otherwise; POSTs must be same-origin JSON (`guard.ts`). Chips show the wallet actually used after any fallback. |
| `data/policy.json` | The mandate. Not readable or writable by any tool exposed to the model. |

## Data flow

```
request --> search_products --> request_approval (gate) --> [human Confirm if > limit]
        --> quote_bridge --> place_order(create) --> pay_shielded
        --> place_order(confirm) = [gateway verifies] --> Bitrefill order
```

1. **search**: Bitrefill `search-products` (live). The agent matches a real product (for example `reliance-jio-india-bundles`).
2. **approve**: the gate evaluates and appends a `decision` entry to the ledger. A human click appends a `human` entry.
3. **quote**: 1Click `dry:true` quote, ZEC to USDC. Informational for settlement, but the gateway prices its invoice from it, so it runs before the invoice.
4. **invoice**: the gateway creates an invoice id and the expected testnet amount: the quoted mainnet ZEC x `GATEWAY_TESTNET_SCALE`, rounded to 1,000 zat and clamped to 0.001-0.01 TAZ, labelled "testnet stand-in". If the quote failed, 0.001 TAZ and the UI says so.
5. **pay**: the agent wallet sends a shielded testnet tx to the gateway address with memo `ZR1|<invoice_id>|<policy_hash8>`. Destination, amount and memo come from code, not from the model.
6. **gateway verifies**: see the next section.
7. **order**: only after step 6 succeeds, the Bitrefill invoice is created (`test` mode: free test product, `payment_method=balance`, `auto_pay`) and the order is read back. The redemption code goes to a UI-only `secret` field, masked until clicked.

Every step stores `mode`, `ids`, `links` and `summary`; the UI renders the mode as a badge. Pay plus verify take about 1.5-2.5 minutes in real time (testnet blocks arrive every 30-75 s); the UI streams progress over SSE and each run is asynchronous.

## The gateway

The gateway plays the merchant side. It has its own wallet, made from a separate mnemonic. Its **unified full viewing key (UFVK)** was imported into a **view-only** zingo wallet, and only that wallet is polled, so the gateway process can see incoming payments but cannot spend (`wallet_kind` reports "Loaded from unified full viewing key"). Modes: `ufvk` (default with `ZEC_WALLET=zingo`), `wallet` (full wallet), `mock`.

Matching rules. A payment counts for an invoice only if all three hold:
1. **Memo**: a decrypted incoming memo equals `ZR1|<invoice_id>|<hash8>` for that invoice.
2. **Amount**: the received amount is at least the expected amount.
3. **Mined**: the transaction is in a block. A transaction seen only in the mempool is reported ("waiting for it to be mined") but not accepted.

**Timeout means no order.** The watcher polls every `GATEWAY_POLL_MS` until `GATEWAY_TIMEOUT_MS` (12 minutes by default). If nothing matches, step 6 fails, step 7 is skipped with "NOT placed: the gateway did not verify ...", and no Bitrefill call is made. This was tested live with an 8 s timeout: the payment was sent and seen in the mempool, and no order was created.

**Order dependency.** `place_order(confirm)` runs the verification in code before it touches Bitrefill. The model cannot call the order step "directly" and skip it, and the gate's checks (same product and amount as approved, budget still fits) still apply to both `pay_shielded` and `place_order`.

A cross-process lock (`<wallet dir>/.zr-session.lock`, atomic `mkdir`, holding the owner's PID) stops the web server and the CLI from opening the same zingo wallet at once. The holder removes it on exit, SIGINT and SIGTERM; a lock whose PID is dead is stale and taken over at once (a lock without a PID file falls back to a 10-minute age rule). Before any of this, `ZEC_WALLET=zingo` runs a preflight (5 s cap per call) that Docker answers and the `zecrecharge/zingo-cli` image exists, and fails fast with the build command otherwise.

## Privacy facts: who sees what

- **The chain** sees a shielded transaction, its timing and its fee. Amount, sender, recipient and memo are encrypted.
- **The gateway** decrypts amount and memo with its viewing key, because it is the recipient. It never learns the agent's address (shielded senders are not revealed), and it cannot spend.
- **Bitrefill** sees only the order: product and delivery details. It never sees a Zcash address, the payment or the memo. In this build Bitrefill is not paid in ZEC; the test order is paid from a test balance.
- **lightwalletd** (`testnet.zec.rocks`) sees the client IP and which blocks and transactions each wallet downloads, for both the agent wallet and the gateway wallet. It cannot read notes. This build has no mixnet or Tor, so the IP is exposed.
- **The LLM provider** (only in `AGENT_MODE=llm`) sees the request text, search results, prices and tool results (ids, txid, memo). It does not see keys or redemption codes (`has_code: true` only).
- **NEAR Intents 1Click** sees the dry-quote request only; nothing is swapped.

## The policy gate

`data/policy.json` (default mandate): ₹1,000 per day, at most ₹1,000 per purchase, human confirm above ₹500, merchant allow-list `["bitrefill"]`, category caps `mobile_topup` ₹600 and `gift_card` ₹1,000, day = calendar day in IST.

`evaluate(policy, request, ledger, now)` is pure: it denies for an invalid amount, a merchant not on the allow-list, an unknown category, the per-purchase cap, the daily budget or a category cap, and sets `needsHuman` above the confirm limit. Spend is computed from the ledger, not from anything the model says.

### Why the LLM cannot bypass it

- **Enforcement is in the tools, not the prompt.** `place_order` and `pay_shielded` call `gate.authorize()` first and throw `GateError` unless the run has: an allowed decision; a human "yes" if one was needed; the same product and amount as were approved; and the budget still fits against the ledger at that moment (re-checked, so two concurrent runs cannot both spend the last rupees).
- **The model has no tool to change policy, ledger or the human answer.** The tools are `search_products`, `quote_bridge`, `request_approval`, `pay_shielded`, `place_order`. The human decision arrives through a separate HTTP endpoint (`POST /api/confirm/:id`, loopback-only by default, cross-origin POSTs refused) or CLI prompt, not through a tool.
- **A denial is final, in code.** Once the gate denies a request or a human rejects it, `AgentTools` refuses every later `request_approval`, `quote_bridge`, `place_order` and `pay_shielded` in that run, and `run.status` stays `denied`/`rejected` (tested with a model that retries a smaller amount). `recordHuman` also refuses to record a yes for a denied request.
- **Code, not the model, sets the memo and the amounts.** The model passes an invoice id; the memo, destination and zatoshi amount come from code. Tool arguments are checked against the approved request.
- **Auditable.** Each decision, human click and spend is appended to `data/ledger.jsonl`, and the policy hash (first 8 hex in the memo, full sha256 in the ledger) binds a payment to the exact policy that allowed it.
- **Defence in depth in the adapters.** Bitrefill `test` mode refuses non-test products (`test_mode_guard`); `real` mode refuses auto-pay of real products without `BITREFILL_ALLOW_REAL_SPEND=yes` (`spend_guard`); the wallet factory refuses any network but testnet.

Limits, stated plainly: the gate trusts the operator who edits `policy.json` and the process running the code. The ledger is a local file, not tamper-proof. The category and amount come from the request parser or the model's `request_approval` arguments, so a model that lies about the category could pick a looser cap; the per-purchase cap, the daily budget and the allow-list still hold.

## Modes

| Setting | Values | Effect |
|---|---|---|
| `AGENT_MODE` | `scripted` (default), `llm` | Who picks tool calls. |
| `BITREFILL_MODE` | `offline` (default), `test`, `real` | `offline`: search live via guest MCP, invoice/order fixtures. `test`: v2 REST, free test products only. `real`: v2 REST, real products; auto-pay needs an explicit env opt-in; crypto invoices are created unpaid. A live failure degrades to fixtures and says why (`fallbackReason`). |
| `GATEWAY_MODE` | empty (default), `ufvk`, `wallet`, `mock` | Empty means `ufvk` with `ZEC_WALLET=zingo`, else `mock`. Also `GATEWAY_TIMEOUT_MS`, `GATEWAY_POLL_MS`, `GATEWAY_TESTNET_SCALE`. |
| `ZEC_WALLET` | `mock` (default), `zingo`, `manual`, `zecli` | `zingo`: real testnet (payer to the gateway). `manual`: txid from `WALLET_TXID_OVERRIDE`. `mock`: no chain. |
| `ONECLICK_MODE` | `dry` (default), `offline` | Live dry quote or fixture. |
| `ZR_USE_FAKES=1` | | Force the in-memory fakes for all adapters. |

Mode labels in results: `real`, `test`, `quote`, `fixture`, `mock`, `manual`. A result never claims a stronger mode than the code that produced it.
