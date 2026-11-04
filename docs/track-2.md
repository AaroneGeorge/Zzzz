# Track 2: Bitrefill client and NEAR Intents bridge quote

Owner: implementer T2. Files: `src/bitrefill/**`, `src/bridge/**`, `scripts/bitrefill-*.ts`, `docs/bitrefill-feedback.md`, this file.
Dependency added: `@toon-format/toon` (MIT). Bitrefill MCP tool results are TOON text, not JSON.

## Status (2026-11-04, about 18:40 IST)

| Leg | State | Mode label |
|---|---|---|
| Guest MCP (no key): register, token, initialize, `search-products` / `get-product-details` | **LIVE, working** | `real` / `mcp-guest` |
| NEAR Intents 1Click dry quote ZEC to USDC (Base) | **LIVE, working**, no funds and no key | `quote` |
| v2 REST (`ping`, search, invoice, order) | Code and mocks done and unit-tested; **not run live: no BITREFILL_API_KEY** | `test` / `real` / `v2` |
| Offline fixtures | Catalog recorded from real guest-MCP calls; v2 invoice and order shapes synthesised from the docs OpenAPI | `fixture` |

## Commands

```bash
bun test src/bitrefill src/bridge        # 20 tests, offline (fake fetch only; passes with the network blocked)
bun run bitrefill:selftest               # live guest-MCP search + live 1Click dry quote (+ v2 ping and free test order if key)
bun run bitrefill:selftest -- --record   # with a key: also saves the raw v2 responses to src/bitrefill/fixtures/v2/
bun run scripts/bitrefill-record-fixtures.ts   # re-record the MCP + 1Click fixtures from live calls
```

Last results: `bun test`: 20 pass, 0 fail. Selftest: "DONE — all live checks passed", printing "NO KEY — skipping v2".
Example dry quote: 0.00236681 ZEC (about $3.03) for 3.0 USDC on Base, ETA 459 s.

## API (for T3 and integration)

```ts
import { createBitrefill } from "./bitrefill";   // reads BITREFILL_MODE, BITREFILL_API_KEY
const b = createBitrefill();                       // or createBitrefill({ mode, apiKey, fetch, liveSearch })
b.mode; b.hasKey; (b as any).degradedReason        // test/real without a key, so it runs offline and says why
await b.ping()                                     // {ok, message, mode, source}
await b.searchProducts("jio", { country: "IN", includeTest: true })   // BrProduct[] (Product & {mode, source, ...})
await b.getProductPackages("reliance-jio-india-bundles")              // one BrProduct per package: packageId, priceUsd, value
await b.createInvoice([{ productId: "test-gift-card-code", value: 10 }], "balance", { autoPay: true })  // BrInvoice
await b.waitForInvoice(id); await b.getInvoice(id); await b.getOrder(orderId)  // BrOrder {code, link, instructions, mode}
await b.mcpCall("search-products", { query: "jio", country: "IN", intent: "..." })  // raw guest MCP, decoded TOON

import { getBridgeQuote } from "./bridge";
await getBridgeQuote(zecRefundAddr, usdcBaseRecipient, usdAmount)  // BridgeQuote & {mode: "quote"|"fixture", notes, ...}
```

Mode rules (`BITREFILL_MODE`):
- `offline` (the default): ping, invoices and orders are fixtures. **Search is still live** through guest MCP unless
  `BITREFILL_LIVE_SEARCH=0`. Test products are appended as `fixture` because guests can't see them.
- `test`: v2 REST with the key. Invoicing anything that isn't a test product throws `test_mode_guard`.
- `real`: v2 REST. `autoPay` of a real product throws `spend_guard` unless `BITREFILL_ALLOW_REAL_SPEND=yes`. Crypto
  invoices are created **unpaid** and shown with `payTo` only.
- A live call that fails degrades to fixtures with `fallbackReason` set. It never fails silently.

Bridge (`ONECLICK_MODE=dry|offline`, default dry):
- Only dry quotes are made, so a deposit address is never issued.
- 1Click is mainnet-only, so a testnet or shielded refund address is replaced by the unspendable placeholder
  `t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs` (zero pubkey hash).
- A missing or invalid recipient is replaced by Bitrefill's public x402 Base pay-to address.
- Both substitutions are flagged in `refundToIsPlaceholder`, `recipientIsPlaceholder` and `notes[]`.
- Set `ZEC_REFUND_MAINNET_TADDR` for the selftest if you have a real t1 address.

## Facts verified live (they differ from PLAN B.2/B.3)

- The 1Click native ZEC asset is `nep141:zec.omft.near`, **not** `zec:ZEC`.
- Guest MCP tools are `search-products, get-product-details, buy-products, get-invoice-by-id` plus 3 help-article
  tools. `search-products` **requires `intent`**.
- MCP `country` must be upper-case alpha-2. `"in"` returns "Search service not available".
- The MCP rate limit header is 60 requests per 30 s, not the documented 30/min.
- `https://api.bitrefill.com/mcp/<key>` returns 410. Use `Authorization: Bearer <key>` on `/mcp`.
- Jio packages are named plans with a USD price only (no INR face value). The cheapest is "₹7.47 Talktime Top-Up" at
  $0.11, and "₹14.95 Talktime Top-Up" is $0.23.

## Human actions needed

1. **BITREFILL_API_KEY**: bitrefill.com, then Account, then Developers, then API Keys, then Create. Put it in `app/.env`,
   then run `bun run bitrefill:selftest -- --record`. It does ping, lists test products, makes a free
   `test-gift-card-code` order (balance, auto_pay) and prints the code. If the order fails with "product not
   found", ask the Bitrefill mentors to enable test products on the account.
2. Optional: a mainnet t1 address as `ZEC_REFUND_MAINNET_TADDR`, so the dry quote shows our own refund address
   instead of the placeholder.
