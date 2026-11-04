# Stadium submission text (copy-paste)

Placeholders to fill before submitting: `{{ZEC_TXID}}`, `{{REPO_URL}}`, `{{VIDEO_URL}}`.

## Project name
ZecRecharge

## Tagline (80 chars max)
An AI agent spending shielded ZEC at Bitrefill, within a budget it can't break

## Track
Both (Privacy and Agentic)

## Description (300 words max)
ZecRecharge is an AI agent that buys everyday Indian goods (Jio recharges, Amazon Pay and Flipkart cards) from Bitrefill and pays from a shielded Zcash wallet. A spending mandate sits between the model and the money, and the model cannot override it.

What is live today: product search runs against Bitrefill's hosted MCP with a guest token, no key needed. The agent sends a real shielded Zcash testnet transaction with a memo `ZR1|<invoice_id>|<policy_hash>` that ties the payment to the Bitrefill invoice and to the exact policy that approved it; the memo is decrypted and shown back. A live NEAR Intents 1Click dry quote shows what the ZEC to USDC-on-Base leg would cost. Every step has a mode badge (real, test, quote, fixture, mock, manual), so a fixture can never pass as a payment.

The policy gate is code, not a prompt: Bitrefill-only allow-list, ₹1,000 daily budget, per-category caps, and a human Confirm above ₹500. It is enforced inside the `place_order` and `pay_shielded` tools, re-checked against an append-only ledger, and bound to the exact product and amount approved. In the demo, ₹239 Jio is auto-approved, ₹700 Amazon Pay waits for a click, ₹1,500 Flipkart is denied.

What is not real yet, stated plainly: the testnet send is a self-transfer and does not settle the Bitrefill invoice; the swap is a quote, not executed; with no API key the invoice and order are fixtures (with a key, free Bitrefill test products). No mainnet money moves.

Runs with zero keys (`bun run demo`), with an Anthropic key for LLM mode, and with a Bitrefill key for test orders. Next, in 30 days: a real mainnet ZEC to USDC to Bitrefill purchase and a Telegram front-end.

## How it uses Zcash
- Real shielded **testnet** transaction (Orchard, zingo-cli against `testnet.zec.rocks`) sent by the agent after the gate approves. Txid: `{{ZEC_TXID}}`, explorer: `https://testnet.zcashexplorer.app/transactions/{{ZEC_TXID}}`.
- The encrypted memo carries `ZR1|<bitrefill invoice id>|<first 8 hex of the policy sha256>`: an on-chain-private receipt linking payment, invoice and mandate. The wallet decrypts it and the UI shows it.
- Default send is a 0.001 TAZ self-transfer, so the memo can be decrypted by us. It does not pay Bitrefill.
- Wallet adapters: zingo (real testnet), manual (human sends from a phone, txid supplied), mock. The wallet factory refuses any network except testnet.
- zecli was tried first and dropped: it has no public testnet backend (documented in `docs/track-1.md`).

## How it uses Bitrefill
- Hosted MCP (`api.bitrefill.com/mcp`) with a guest `client_credentials` token: live `search-products` and `get-product-details` for Jio, Airtel and Amazon cards in India. No key.
- REST v2 client (`/ping`, `/products`, `/invoices`, `/orders`) with a free test-product flow (`test-gift-card-code`, `test-phone-refill`, balance + auto_pay). It needs an API key and enabled test products; without it, invoice and order are labelled fixtures.
- Real-spend guard: real products need `BITREFILL_MODE=real` plus an explicit opt-in; crypto invoices are created unpaid.
- Tool annotations (`destructiveHint`) informed the design of the gate. 22 documented rough edges with repros in `docs/bitrefill-feedback.md`.

## Privacy note (3,000 chars max)
Goal: an agent that spends privately and within limits.

What each party sees:
- Bitrefill: the product, the delivery phone number or email, the invoice and, in a live flow, a USDC-on-Base payment coming from the swap provider. It never sees our Zcash addresses, balance, history or the memo.
- The Zcash chain (everyone): a shielded transaction exists, with its timing and fee. Amount, sender, receiver and memo are encrypted. In a live flow, the last hop into a swap deposit address would be a transparent output; that hop is the only public link and it is not our wallet's history.
- lightwalletd (testnet.zec.rocks): the wallet's IP address and which blocks and transactions it downloads. It cannot read notes, amounts or memos. Zingolib does not hide the client IP, so a user who cares should connect through Tor or a VPN. We did not add that.
- LLM provider (Anthropic, only in LLM mode): the request text, search results and prices, and tool results such as invoice id, order id, txid and memo. It never receives wallet keys or redemption codes: the code goes to a UI-only field and the model sees only `has_code: true`. Scripted mode sends nothing to any LLM.
- NEAR Intents 1Click: the quote request (amounts, refund and recipient addresses). Only dry quotes are made, so no deposit address is issued.

Design choices:
- The mandate (`policy.json`) is read by code, never by the model. Its hash is in every memo, so a payment can be audited against the policy that allowed it.
- Secrets (`.env`, wallet mnemonic) are git-ignored; the wallet is testnet-only.
- The local ledger records product, amount and txid and is never uploaded.

Limits we state plainly: the testnet transaction is a self-transfer, so it demonstrates the shielded send and memo, not a payment to Bitrefill. The ledger is a local file, not tamper-proof. The shielded to transparent bridge hop in a mainnet flow leaks that a swap happened; fixing that needs a native ZEC payment method at Bitrefill or a shielded swap path, which is our 30-day plan.

## Testnet txid
`{{ZEC_TXID}}`
(Zcash testnet, shielded, memo `ZR1|<invoice_id>|<hash8>`; evidence in `docs/zcash-leg.md`.)

## 30-day ecosystem milestone
Make the settlement leg real on mainnet: shielded ZEC through NEAR Intents 1Click (and Zodl CrossPay where available) into USDC on Base at the Bitrefill invoice address, with under-payment and 15-minute-expiry handling. Ship a Telegram front-end ("recharge my Jio") behind the same mandate gate. Success: one real mainnet purchase end to end with a published chain of ids (shielded txid, swap id, Bitrefill invoice and order), plus the policy gate released as a small reusable library for other Zcash agents.

## Bitrefill feedback: what worked
(Full log with repros: `docs/bitrefill-feedback.md`.)
1. Guest checkout auth: two calls (`/oauth/mcp/register`, `/oauth/mcp/token`) give a token with no account. Lowest-friction agent onboarding we have seen.
2. Error messages that say what to do (410 for key-in-URL, 400 for missing Accept).
3. Stateless MCP server: a plain `fetch` POST works, our client is about 150 lines.
4. Correct tool annotations (`readOnlyHint`, `destructiveHint`) that a spending gate can use directly.
5. Rich product data: `recipient_type`, grouped `payment_methods`, `in_stock`, ratings.
6. Machine-readable docs (`llms.txt`, a `.md` twin per page with OpenAPI) and a deep India catalog (Jio, Airtel).

## Bitrefill feedback: what didn't
1. Docs still say to put the key in the MCP URL (HTTP 410); the partner guide says never (F1).
2. Guests cannot see test products, so there is no zero-human end-to-end purchase test (F13). Suggest visible `test-*` products or a hackathon sandbox.
3. No ZEC payment method; we had to bridge through 1Click into `usdc_base` (F20). Also a 15-minute invoice expiry is tight for bridged payments (F21).
4. MCP results are TOON text with no `structuredContent` or `outputSchema`, hard for a gate that must read prices in code (F7).
5. Search misses obvious queries ("amazon india" drops the Amazon.in card; no Amazon Pay card) and `country` in lower case returns a misleading "service unavailable" (F9, F10).
6. Jio packages have no INR face value, so "recharge ₹239" cannot be matched without scraping plan names (F12). Also OpenAPI types contradict the guides (F15; docs-based, not live-verified).

## Tech stack
Bun 1.4 and TypeScript; Anthropic SDK (Claude, optional LLM mode); Bitrefill MCP (guest) and REST v2; NEAR Intents 1Click API; zingo-cli (Docker) against a Zcash testnet lightwalletd; `@toon-format/toon`; plain HTML plus SSE web UI; JSONL audit ledger. MIT licence.

## Repo URL
`{{REPO_URL}}`

## Video
`{{VIDEO_URL}}`
