# Stadium submission text (copy-paste)

Placeholders still to fill before submitting: `{{REPO_URL}}`, `{{VIDEO_URL}}`. The testnet txid is filled in.

## Project name
ZecRecharge

## Tagline (80 chars max)
An AI agent spending shielded ZEC at Bitrefill, within a budget it can't break

## Track
Both (Privacy and Agentic)

## Description (300 words max)
Shielded ZEC can pay for Bitrefill today through a viewing-key gateway, and the agent's spending is bounded by a mandate it can't override.

ZecRecharge is an AI agent that buys Indian goods (Jio recharges, Amazon Pay and Flipkart cards) from Bitrefill and pays in shielded Zcash. It searches Bitrefill live, and a policy gate in code approves, asks a human, or denies. The agent then sends a shielded Zcash testnet transaction to a separate gateway wallet, with memo `ZR1|<invoice>|<policy_hash8>`.

The gateway holds only a view-only (UFVK) wallet. It decrypts the memo and amount, checks the memo matches the invoice, the amount is enough and the transaction is mined, and only then is the Bitrefill order placed. If verification times out, no order is placed (tested live). The gateway never learns the agent's address; Bitrefill sees only the order.

The mandate is Bitrefill-only allow-list, ₹1,000 daily budget, category caps and human Confirm above ₹500. It is enforced inside the money-moving tools against an append-only ledger, bound to the exact product and amount approved. ₹239 Jio is auto-approved, ₹700 Amazon Pay waits for a click, ₹1,500 Flipkart is denied. Every step carries a badge (real, test, quote, fixture, mock, manual).

What is real: live Bitrefill search, the gate, real shielded testnet transactions, real viewing-key verification, and real Bitrefill API orders. What is labelled: the orders are free Bitrefill test products, the gateway is our own testnet merchant stand-in, the testnet amount is the quoted mainnet ZEC clamped to 0.001-0.01 TAZ, and the ZEC to USDC leg is a quote only. No mainnet payment was made and no real product was bought.

Runs with zero keys (`bun run demo`). Next: mainnet settlement and Telegram.

## How it uses Zcash
- Real shielded **testnet** transactions (zingo-cli against `testnet.zec.rocks`) from the agent wallet to a gateway wallet, sent only after the gate approves. Example txid: `0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f`, explorer: `https://testnet.zcashexplorer.app/transactions/0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f` (block 4,582,167, shielded, fee 0.0001 TAZ, verified on the explorer).
- Encrypted memo `ZR1|<invoice id>|<first 8 hex of the policy sha256>` links payment, invoice and mandate. The gateway decrypts it.
- Viewing keys as the merchant integration: the gateway imports only a UFVK (`zingo-cli --viewkey`), so it can detect and verify payments but cannot spend. Its verification (memo, amount, mined) gates the Bitrefill order.
- Negative test on testnet: with the timeout forced to 8 s, a paid-but-unverified payment led to no order (txid `92cdb323eb15211576b4d2db6d6a31cd38ced754d2ae88bbf5a4bc1950eb32e0`).
- Wallet adapters: zingo (real testnet), manual (human sends from a phone), mock. The factory refuses any network except testnet. zecli was tried first and dropped (no public testnet backend, see `docs/track-1.md`).

## How it uses Bitrefill
- Hosted MCP and REST v2 with a real key in `test` mode: live product search; then a real v2 invoice with `payment_method=balance` and `auto_pay` for the free test products `test-phone-refill` and `test-gift-card-code`. Both went `delivered` in our runs, at zero cost.
- The order is placed only after the gateway has verified the shielded payment, so the ZEC payment causes the purchase. The matched real product (for example `reliance-jio-india-bundles`) is shown but not bought.
- Real-spend guard: real products need `BITREFILL_MODE=real` plus an explicit opt-in; we never used it.
- Tool annotations (`destructiveHint`) informed the gate design. 22 documented rough edges with repros in `docs/bitrefill-feedback.md`.

## Privacy note (3,000 chars max)
Goal: an agent that pays privately and within limits.

What each party sees:
- The Zcash chain (everyone): a shielded transaction, its timing and fee. Amount, sender, recipient and memo are encrypted.
- The gateway: it decrypts amount and memo with its viewing key, as the recipient. It never learns the agent's address and cannot spend, because it holds only a view-only wallet.
- Bitrefill: only the order (product, delivery phone or email). It never sees a Zcash address, the payment or the memo.
- lightwalletd (testnet.zec.rocks): the IP address of each wallet and which blocks and transactions it downloads. It cannot read notes, amounts or memos. This build has no mixnet or Tor, so the IP is exposed; a user who cares should use Tor or a VPN.
- LLM provider (Anthropic, only in LLM mode): the request text, search results and prices, and tool results such as invoice id, order id, txid and memo. It never receives wallet keys or redemption codes (the model sees only `has_code: true`). Scripted mode sends nothing to an LLM.
- NEAR Intents 1Click: the dry-quote request only; nothing is swapped.

Design choices:
- The mandate (`policy.json`) is read by code, never by the model. Its hash is in every memo, so a payment can be audited against the policy that allowed it.
- Order placement runs the gateway verification in code. The model cannot skip it, and a timeout means no order.
- Secrets (`.env`, wallet mnemonics, the gateway UFVK file) are git-ignored; the wallets are testnet-only.
- The local ledger records product, amount and txid and is never uploaded.

Limits we state plainly: this is testnet. The gateway is our own stand-in merchant; Bitrefill does not accept ZEC, so the Bitrefill test order is not paid with the ZEC. The ZEC to USDC settlement is a quote only. A real mainnet flow would reveal a swap hop (transparent output into a deposit address); fixing that needs a native ZEC payment method at Bitrefill or a shielded swap path, our 30-day plan. The ledger is a local file, not tamper-proof. The viewing-key gateway sees every payment sent to it.

## Testnet txid
`0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f`
(Zcash testnet, shielded, block 4,582,167, fee 0.0001 TAZ, memo `ZR1|zrg-32415-c32y-0542e7|<hash8>`; verified on the explorer. More in the README Evidence section and `docs/integration.md`.)

## 30-day ecosystem milestone
Make the settlement leg real on mainnet: shielded ZEC through NEAR Intents 1Click (and Zodl CrossPay where available) into USDC on Base at the Bitrefill invoice address, with under-payment and 15-minute-expiry handling. Ship a Telegram front-end ("recharge my Jio") behind the same mandate gate. Success: one real mainnet purchase end to end with a published chain of ids (shielded txid, swap id, Bitrefill invoice and order), plus the policy gate released as a small reusable library for other Zcash agents.

## Bitrefill feedback: what worked
(Full log with repros: `docs/bitrefill-feedback.md`. Items marked "verified live" were hit with a real key on 2026-11-04.)
1. **Verified live:** a test-product invoice with `payment_method=balance` and `auto_pay=true` completes at zero cost on a 0-BTC account. `test-gift-card-code` and `test-phone-refill` both reached `delivered` in our end-to-end runs (about 140 ms from created to delivered for the gift card).
2. **Verified live:** `products/search?q=test&include_test_products=true` returns 16 test products, including `*-fail` variants that are useful for negative tests.
3. Guest checkout auth: two calls (`/oauth/mcp/register`, `/oauth/mcp/token`) give a token with no account. Lowest-friction agent onboarding we have seen.
4. Error messages that say what to do (410 for key-in-URL, 400 for missing Accept), and correct tool annotations (`readOnlyHint`, `destructiveHint`) that a spending gate can use directly.
5. Rich product data (`recipient_type`, grouped `payment_methods`, `in_stock`), machine-readable docs (`llms.txt`, a `.md` twin per page) and a deep India catalog (Jio, Airtel).

## Bitrefill feedback: what didn't
1. **Verified live:** v2 search for "Amazon" in India returns only Amazon Fresh packages, so an "Amazon Pay gift card" request matches a grocery card; guest MCP lists "Amazon.in Shopping India" but as `in_stock=false`. Suggest a product `category` and `in_stock` in v2 search.
2. **Verified live:** the paid test invoice reports `payment: {method: "balance", currency: "BTC", price: 13418, status: "complete"}` with nothing saying "test", and the balance stays 0. Suggest an `is_test` flag on invoice and order.
3. **Verified live:** `POST /v2/invoices` returns `not_delivered`; only a re-fetch shows `all_delivered`, even for instant test products. Document the state machine or return the final state when `auto_pay` completes.
4. **Verified live:** the docs path and reality differ: the balance endpoint is `/v2/accounts/balance`, and `/v2/account/balance` returns an Express HTML 404 instead of JSON.
5. No ZEC payment method; we had to design around a bridge to `usdc_base` (F20), and a 15-minute invoice expiry is tight for bridged payments (F21). This is why the gateway is a stand-in.
6. Guests cannot see test products, so there is no zero-human end-to-end test without a key (F13). MCP results are TOON text with no `structuredContent`, hard for a gate that must read prices in code (F7). Jio packages have no INR face value (F12).

## Tech stack
Bun 1.4 and TypeScript; Anthropic SDK (Claude, optional LLM mode); Bitrefill MCP (guest) and REST v2; a viewing-key (UFVK) payment gateway; NEAR Intents 1Click API; zingo-cli (Docker) against a Zcash testnet lightwalletd; `@toon-format/toon`; plain HTML plus SSE web UI; JSONL audit ledger. MIT licence.

## Repo URL
`{{REPO_URL}}`

## Video
`{{VIDEO_URL}}`
