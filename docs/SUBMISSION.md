# Stadium submission: field-by-field paste sheet

Placeholder left: `{{CONTINUING_LINK}}` (upstream issue, if we file one). Repo and video URLs are filled in. Length limits we know of: pitch 80 characters, privacy note 3,000 characters. Both are checked below.

## Project name
ZecRecharge

## Pitch (one line, 80 chars max)
Agent pays Indian Jio/gift-card orders in shielded ZEC under a spend mandate

## Tracks
Both (Privacy and Agentic)

## Track split
- **Privacy:** the shielded testnet payment with a memo, the view-only (UFVK) gateway that verifies it, the privacy and trust note, the Zcash friction in FEEDBACK.md Part 2, the testnet txids.
- **Agentic:** the agent loop, live Bitrefill search and test-product orders, the spending mandate and policy gate, the human-confirm step, the Bitrefill feedback in FEEDBACK.md Part 1, the invoice id below.
- **Both:** a verified shielded payment is what triggers the order, so the ZEC payment causes the purchase.

## Technologies
Bun 1.4.3 and TypeScript; Anthropic SDK 1.4 (`claude-sonnet-5-5`, optional LLM mode); Bitrefill hosted MCP (guest) and REST v2; NEAR Intents 1Click API v0 (dry quotes); zingo-cli from zingolib `dev` commit `3f2529e2` in Docker; lightwalletd v0.6.1 at `testnet.zec.rocks`; Zcash testnet (NU6.3, v6 transactions); `@toon-format/toon` 4.4; plain HTML with SSE; JSONL ledger. MIT licence.

## Testnet txid and explorer link
Txid (shown in the demo video): `981571a1b92044412ce94acc2a3f0304ecc614772a266140a888d541b6f70b31`
Explorer: https://testnet.zcashexplorer.app/transactions/981571a1b92044412ce94acc2a3f0304ecc614772a266140a888d541b6f70b31
Block 4,582,317, shielded, agent wallet to gateway wallet. (Plain `curl` gets HTTP 403 from the explorer; use a browser.)

Second example: `0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f`, block 4,582,167, 0.00658 TAZ, fee 0.0001 TAZ, memo `ZR1|zrg-32415-c32y-0542e7|<hash8>`.
https://testnet.zcashexplorer.app/transactions/0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f

## Receiving wallet viewing key and birth height (optional)
Viewing key (UFVK, gateway wallet, testnet): `uviewtest1kted23sqr3yf3ttzrrxcqg0mpyh8t089smuh730d4zhzaw73q8u58895dflm049p3xmzx3xx926kl7lg5l93jeleetnkqqdtjfj0yylxysmefn9xx868enuxd8ajkmxta34dh5fg7qdvdardgel094dezsp60qecwdpkrneqkx7pe2yzt6gwexmk8974c6sguvqag5dqga9f3qzxnkhu8asnpp2tzspseztcwtwde4hj42v9y7hqt2q0uhqpdgwx52lhfqux5c570tu79rvnxtsk0phzddurasnd3e25clnrz636x32622d45xq80tkn8ak223hvhn5mlma96jrswqpaaxv2wy6q65q5rt4dv3uulyxk3jgy9lwenhm8u9csqqv3jef2yxzmq2x2h36chdnmrs3w2hccv2ytamu6j6q6hnfzg34m7u8r0jcggce8vugkarydrxpr3jxujc39g3hlmykdc9us2jm79rgm6eh4se0nlczetl7p`
Birth height: 4,582,051
Import it into a view-only testnet wallet (for example `zingo-cli --viewkey`) to see the amount and memo of each payment to the gateway.

## Privacy and trust note (3,000 chars max)
1. What stays private. On chain, a shielded transaction shows only that it happened, its timing and its fee. Amount, sender, recipient and memo are encrypted. The memo holds an invoice id and 8 hex of the policy hash. The gateway never learns the agent's address or history and cannot spend, because it holds only a view-only wallet. Bitrefill never sees a Zcash address, the payment or the memo. Wallet keys never leave the machine, and redemption codes never reach the model.

2. What the app reveals, and to whom.
- Light-wallet server (testnet.zec.rocks): the wallet's IP address and which blocks and transactions it fetches. It cannot read amounts or memos. This build has no Tor or mixnet.
- Our own server: everything about a run (request text, product, amount, invoice id, txid, memo) and, through the viewing key, each payment to the gateway. It is stored in a local JSONL ledger and not uploaded.
- Bitrefill: the search queries, the product, the delivery phone or email, and the order. Never the ZEC payment.
- AI model provider (Anthropic, LLM mode only): the request text (which can include a phone number), search results and prices, and tool results such as invoice id, order id, txid and memo. Not wallet keys or redemption codes. Scripted mode sends nothing to a model.
- NEAR Intents 1Click: the dry-quote request only; nothing is swapped.

3. Who users must trust. The gateway operator, who sees every payment sent to it and decides when the order is placed (here, us, as a stand-in merchant). The app operator, who can read the ledger. The light-wallet server not to log IP addresses. The model provider and Bitrefill with the details above. The policy gate is plain code reading `policy.json`, not an audited system, and the ledger is a local file that is not tamper-proof. The web UI has no login and binds 127.0.0.1 by default.

4. What we would fix next. Route the wallet through Tor or Nym. Redact phone numbers before they reach the model. Make settlement real: Bitrefill does not accept ZEC, and a mainnet swap path would expose one transparent hop, so it needs a native ZEC method or a shielded swap. Make the ledger tamper-evident. Replace our own gateway with an existing viewing-key merchant tool.

This is testnet: the order is a free Bitrefill test product and the ZEC to USDC leg is a quote only.

## 30-day next step
Make settlement real on mainnet: shielded ZEC through NEAR Intents 1Click (and Zodl CrossPay where available) into USDC on Base at the Bitrefill invoice address, with under-payment and 15-minute invoice-expiry handling (our feedback items F20 and F21 in https://github.com/AaroneGeorge/Zzzz/blob/main/docs/bitrefill-feedback.md). Then a Telegram front-end ("recharge my Jio") behind the same mandate gate, and the gate released as a small library for other Zcash agents. Success: one real mainnet purchase with a published chain of ids (shielded txid, swap id, Bitrefill invoice and order).
Repo: https://github.com/AaroneGeorge/Zzzz
Upstream issue we may file: `{{CONTINUING_LINK}}`

## Demo video URL
https://github.com/AaroneGeorge/Zzzz/releases/download/v1.0-demo/zecrecharge-demo.mp4

## Repo URL
https://github.com/AaroneGeorge/Zzzz

## Bitrefill touchpoints used (one paragraph)
Hosted MCP `search-products` with a guest token (no account) for live catalogue search. REST v2 with an API key in test mode: `GET /v2/ping`, `GET /v2/products/search` (with `include_test_products=true`), `POST /v2/invoices` with `payment_method=balance` and `auto_pay=true`, `GET /v2/invoices/{id}` to poll the final state, and `GET /v2/accounts/balance`. Lane: the API-key lane, not x402. Built by us: the MCP client, the product matcher, the v2 order adapter and state normaliser, the policy gate and ledger, the shielded-payment gateway, and the web UI. Reused from Bitrefill: search, product data, test products, ordering and delivery. The order is placed only after the gateway has verified the shielded payment. We did not use x402 and did not buy a real product.

## Invoice ID of a real purchase
Bitrefill v2 invoice `0fb6f4db-6f80-4f76-8699-c4b5edf067f1` (order `6aeb326986d3593f50960265`, product `test-gift-card-code`, status `delivered`), placed 2026-11-04 18:54 IST right after the gateway verified shielded payment `0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f`. Also, the run shown in the demo video: invoice `e09ab291-114b-4305-bd60-cc2cf3cffbd7` (order `6aeb4069580cd01e17773e31`, `test-gift-card-code`, `all_delivered`, 19:55 IST), placed after the gateway verified txid `981571a1…0b31`.
Honest label: this is a free Bitrefill TEST product enabled on our account, paid with `payment_method=balance` on a 0-BTC balance. It is a real Bitrefill API order, not a real-money purchase. More test invoices are in docs/integration.md. The Bitrefill invoice id for the video run (txid `981571a1...`) is not recorded in the repo.

## Guardrails
From `data/policy.json`, enforced in code inside the money-moving tools, not in the prompt:
- Maximum per purchase: ₹1,000 (category caps: mobile top-ups ₹600, gift cards ₹1,000).
- Maximum per day: ₹1,000, resetting at midnight IST, counted from an append-only ledger.
- Approval: a human must click Confirm above ₹500. Anything above ₹1,000 per purchase is denied and cannot be approved at run time. Only the repo owner can change limits, by editing `policy.json`, which the agent cannot touch.
- Allow-list: `bitrefill` only. The policy hash goes into every shielded memo.
- Real products need `BITREFILL_MODE=real` plus an explicit opt-in; never used.
- Live results: ₹239 Jio auto-approved; ₹700 Amazon Pay waited for Confirm; ₹1,500 Flipkart denied; ₹99 with ₹61 left denied (daily budget).

## Bitrefill feedback: what worked
Full text: FEEDBACK.md Part 1 and docs/bitrefill-feedback.md. "Verified live" means hit with a real key on 2026-11-04.
1. Verified live: a test-product invoice with `payment_method=balance` and `auto_pay=true` completes at zero cost on a 0-BTC account. `test-gift-card-code` and `test-phone-refill` both reached `delivered` (about 140 ms from created to delivered for the gift card).
2. Verified live: `products/search?q=test&include_test_products=true` returns 16 test products, including `*-fail` variants that are useful for negative tests.
3. Guest checkout auth: two calls (`/oauth/mcp/register`, `/oauth/mcp/token`) give a token with no account.
4. Errors that say what to do (410 for key-in-URL, 400 for missing Accept) and correct tool annotations (`readOnlyHint`, `destructiveHint`) that a spending gate can read.
5. Rich product data (`recipient_type`, grouped `payment_methods`, `in_stock`), machine-readable docs (`llms.txt`, `.md` twins) and a deep India catalog.

## Bitrefill feedback: what didn't
1. Verified live: `test-phone-refill` delivered all afternoon, then from 19:33 IST every identical request ended `permanent_failure` with no reason field, while the invoice still said `payment.status: "complete"`. We suggest documenting limits and adding a `failure_reason`. Our app shows this as "PAID · ORDER FAILED".
2. Verified live: the paid test invoice reports `payment: {method: "balance", currency: "BTC", price: 13418, status: "complete"}` with nothing saying "test". We suggest an `is_test` flag.
3. Verified live: `POST /v2/invoices` returns `not_delivered`; only a re-fetch shows `all_delivered`. Document the state machine or return the final state.
4. Verified live: v2 search for "Amazon" in India returns only Amazon Fresh, so an "Amazon Pay gift card" request matches a grocery card; guest MCP lists "Amazon.in Shopping India" as `in_stock=false`. We suggest `category` and `in_stock` in v2 search.
5. Verified live: `/v2/account/balance` returns an Express HTML 404; the real path is `/v2/accounts/balance`.
6. No ZEC payment method, so we built a stand-in gateway; a 15-minute invoice expiry is tight for bridged payments (F20, F21).
7. MCP results are TOON text with no `structuredContent` (hard for a gate that reads prices in code); Jio packages have no INR face value; guests cannot see test products (F7, F12, F13).

## Zcash feedback
Pointer: FEEDBACK.md, Part 2 (https://github.com/AaroneGeorge/Zzzz/blob/main/FEEDBACK.md). Sections: Faucet, Node or indexer, SDK or wallet tool, Wallet, Docs, Other. Short version:
- Faucet: fauzec.com worked through its API with no captcha; the jinolabs faucet returned 503 ("Our node did not report its height").
- Node or indexer: `zaino.testnet.unsafe.zec.rocks` returned 503; `testnet.zec.rocks` (lightwalletd v0.6.1) worked. The only zidecar we found (`zcash.rotko.net`) is mainnet.
- SDK or wallet tool: zcli 0.6.0 `--testnet` fails against that mainnet zidecar; zcli 0.10.0 is mainnet-only; zcli ssh-key derivation is non-portable (a first 1 TAZ is stranded). zingo-cli (zingolib dev `3f2529e2`) works, but `--waitsync` never returns, so we drive the REPL over stdin.
- Wallet: change is locked for 3 confirmations; funds sit in the new `ironwood` pool and transactions are v6 (NU7), which our parser had to learn.
