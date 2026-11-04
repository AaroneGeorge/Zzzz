# Architecture

## Components

| Dir | Role |
|---|---|
| `src/agent` | The loop. `AGENT_MODE=llm` lets Claude pick tool calls; `scripted` parses the request with a regex and calls the same tools in fixed order. Both produce the same six steps. |
| `src/policy` | `evaluate()` (pure function), `PolicyGate` (stateful wrapper, `authorize()`), `Ledger` (append-only JSONL), policy hash and memo builder. |
| `src/bitrefill` | Client: guest MCP (live search, no key), v2 REST (key), offline fixtures. TOON decoding for MCP results. |
| `src/bridge` | NEAR Intents 1Click **dry** quote, ZEC to USDC on Base. |
| `src/wallet` | Wallet interface (`getAddress`, `getBalance`, `send`, `waitConfirmed`, `readMemos`) with adapters `zingo` (zingo-cli in Docker, testnet), `zecli` (addresses only; no public testnet backend), `manual`, `mock`. |
| `src/web` | Bun server plus one static `index.html`: timeline, Confirm card, mandate meters, audit log. |
| `data/policy.json` | The mandate. Not readable or writable by any tool exposed to the model. |

## Data flow

```
request --> search_products --> request_approval (gate) --> [human Confirm if > limit]
        --> place_order(create) --> quote_bridge --> pay_shielded --> place_order(confirm)
```

1. **search**: Bitrefill guest MCP `search-products` (live). The agent matches a real product (for example `reliance-jio-india-bundles`).
2. **approve**: the gate evaluates and appends a `decision` entry to the ledger. A human click appends a `human` entry.
3. **invoice**: `POST /v2/invoices` in `test` mode (free test product, balance + auto_pay); a fixture in `offline` mode. Outside `real` mode the agent always buys the free test stand-in, and the UI says so.
4. **quote**: 1Click `dry:true` quote. Informational only; the run is "done" without it.
5. **pay**: wallet `send(to, amountZat, memo)` with memo `ZR1|<invoice_id>|<policy_hash8>`. Default destination is the wallet's own address (testnet self-transfer, 0.001 TAZ), so the memo can be decrypted and shown. It does not settle the Bitrefill invoice.
6. **deliver**: `getOrder`; the redemption code goes to a UI-only `secret` field, masked until clicked.

Every step stores `mode`, `ids`, `links` and `summary`; the UI renders the mode as a badge.

## The policy gate

`data/policy.json` (default mandate): ₹1,000 per day, at most ₹1,000 per purchase, human confirm above ₹500, merchant allow-list `["bitrefill"]`, category caps `mobile_topup` ₹600 and `gift_card` ₹1,000, day = calendar day in IST.

`evaluate(policy, request, ledger, now)` is pure: it denies for an invalid amount, a merchant not on the allow-list, an unknown category, the per-purchase cap, the daily budget or a category cap, and sets `needsHuman` above the confirm limit. Spend is computed from the ledger, not from anything the model says.

### Why the LLM cannot bypass it

- **Enforcement is in the tools, not the prompt.** `place_order` and `pay_shielded` call `gate.authorize()` first and throw `GateError` unless the run has: an allowed decision; a human "yes" if one was needed; the same product and amount as were approved; and the budget still fits against the ledger at that moment (re-checked, so two concurrent runs cannot both spend the last rupees).
- **The model has no tool to change policy, ledger or the human answer.** The five tools are `search_products`, `quote_bridge`, `request_approval`, `pay_shielded`, `place_order`. The human decision arrives through a separate HTTP endpoint (`POST /api/confirm/:id`) or CLI prompt, not through a tool.
- **A denial is final.** `recordHuman` refuses to record a yes for a denied request.
- **Code, not the model, sets the memo and the amounts.** The model passes an invoice id; the memo, destination and zatoshi amount come from code. Tool arguments are checked against the approved request.
- **Auditable.** Each decision, human click and spend is appended to `data/ledger.jsonl`, and the policy hash (first 8 hex in the memo, full sha256 in the ledger) binds a payment to the exact policy that allowed it.
- **Defence in depth in the adapters.** Bitrefill `test` mode refuses non-test products (`test_mode_guard`); `real` mode refuses auto-pay of real products without `BITREFILL_ALLOW_REAL_SPEND=yes` (`spend_guard`); the wallet factory refuses any network but testnet.

Limits, stated plainly: the gate trusts the operator who edits `policy.json` and the process running the code. The ledger is a local file, not tamper-proof. The category and amount come from the request parser or the model's `request_approval` arguments, so a model that lies about the category could pick a looser cap; the per-purchase cap, the daily budget and the allow-list still hold.

## Modes

| Setting | Values | Effect |
|---|---|---|
| `AGENT_MODE` | `scripted` (default), `llm` | Who picks tool calls. |
| `BITREFILL_MODE` | `offline` (default), `test`, `real` | `offline`: search live via guest MCP, invoice/order fixtures. `test`: v2 REST, free test products only. `real`: v2 REST, real products; auto-pay needs an explicit env opt-in; crypto invoices are created unpaid. A live failure degrades to fixtures and says why (`fallbackReason`). |
| `ZEC_WALLET` | `mock` (default), `zingo`, `manual`, `zecli` | `zingo`: real testnet. `manual`: txid from `WALLET_TXID_OVERRIDE`. `mock`: no chain. |
| `ONECLICK_MODE` | `dry` (default), `offline` | Live dry quote or fixture. |
| `ZR_USE_FAKES=1` | | Force the in-memory fakes for all adapters. |

Mode labels in results: `real`, `test`, `quote`, `fixture`, `mock`, `manual`. A result never claims a stronger mode than the code that produced it.
