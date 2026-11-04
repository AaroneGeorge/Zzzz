# FEEDBACK: ZecRecharge (Free Society Hack Mumbai, 2026-11-04)

> **Builder: edit in your own words before submitting.** This draft was written from our build logs (`docs/track-1.md`, `docs/zcash-leg.md`, `docs/bitrefill-feedback.md`). Every item was hit during the build on 2026-11-04. Times are IST.

This file has two parts. **Part 1** is for the Bitrefill agentic track. **Part 2** is for the Zcash Privacy track.

---

# Part 1: Bitrefill

Full log with repros and suggested fixes: [docs/bitrefill-feedback.md](docs/bitrefill-feedback.md) (9 things that worked, 22 rough edges, F1 to F22). Below: the items we verified live with a real API key first, then the ones that come from the docs and the guest MCP.

## Verified live (REST v2, real key, `BITREFILL_MODE=test`, account balance 0 BTC)

**What worked**
1. A test-product invoice with `payment_method=balance` and `auto_pay=true` completes at zero cost on a 0-BTC account. `test-gift-card-code` and `test-phone-refill` both reached `delivered` in our end-to-end runs, and `GET /v2/accounts/balance` still returned 0 afterwards. The recorded gift-card order took about 140 ms from `created_time` to `delivered_time`.
2. `GET /v2/products/search?q=test&include_test_products=true` returns 16 test products, including `*-fail` variants such as `test-phone-refill-fail`. They are useful for negative tests.

**What didn't work, or confused us**
1. `test-phone-refill` delivered all afternoon, then from 19:33 every identical request ended with order `permanent_failure`, `delivered_time: null`, and no reason field, while the invoice still said `payment.status: "complete"`. The order object has only `id, status, phone_number, product, created_time, delivered_time, commission`. We expected a documented limit or a machine-readable reason, for example `failure_reason`. `test-gift-card-code` kept delivering over the same window. Our app shows this as "PAID · ORDER FAILED", never as done.
2. The paid test invoice reports `payment: {method: "balance", currency: "BTC", price: 13418, status: "complete"}`, which looks like a real balance payment. The balance stays 0 and nothing says "test". We would like an `is_test` flag on invoice and order.
3. `POST /v2/invoices` returns `not_delivered`. Only a re-fetch shows `all_delivered`, even for instant test products. We would like the state machine documented, or the final state returned when `auto_pay` completes.
4. The balance endpoint is `/v2/accounts/balance`. `/v2/account/balance` returns an Express HTML 404 ("Cannot GET") instead of JSON.
5. v2 search for "Amazon" in India returns only Amazon Fresh packages, so an "Amazon Pay gift card" request matches a grocery card. The guest MCP lists "Amazon.in Shopping India" but as `in_stock=false`. We would like a product `category` and `in_stock` in v2 search.

## From the docs and the guest MCP (reproduced with curl, no account)

**What worked:** the guest checkout auth (`/oauth/mcp/register`, then `/oauth/mcp/token`, no account); error messages that say what to do (410 for key-in-URL, 400 for missing Accept); correct tool annotations (`readOnlyHint`, `destructiveHint`) that a spending gate can use; rich product data (`recipient_type`, grouped `payment_methods`); machine-readable docs (`llms.txt`, a `.md` twin per page); a deep India catalog (Jio, Airtel).

**What didn't work** (IDs refer to docs/bitrefill-feedback.md):
- No ZEC payment method (F20). We had to design around a stand-in gateway and a quote to `usdc_base`. The 15-minute invoice expiry is tight for bridged payments (F21).
- MCP results are TOON text with no `structuredContent` or `outputSchema` (F7), which is hard for a gate that must read prices in code.
- Jio packages carry no INR face value, only a USD price and a free-text plan name (F12).
- `search-products` needs an undocumented `intent` (F8). A lower-case `country` fails with "service unavailable" (F9). Full-text search misses obvious matches such as "amazon india" and "amazon pay" (F10).
- Guests cannot see test products, so there is no zero-human end-to-end test without a key (F13).
- The eCommerce MCP docs still show the key-in-URL form that returns 410 (F1). OAuth discovery does not follow the MCP auth spec (F3). The OpenAPI schemas contradict the guides on types and example shapes (F15). Invoice and order statuses are not enumerated (F16).

---

# Part 2: Zcash

Everything here was on **testnet**. Sections follow the Privacy track template: Faucet, Node or indexer, SDK or wallet tool (with version), Wallet, Docs, Other. For each item: what we tried, what happened, what we expected, and a link or error.

## Faucet

**fauzec.com (worked, with a surprise)**
- Tried: `POST /api/v1/claim` with our testnet unified address, 18:25 and 18:27.
- Happened: accepted with no captcha. 1 TAZ arrived each time. Txids `6379c6211688ada82caee701d8dab378ede23191853cf0ef3d05b651436bfe68` and `22a9c727bf2a375772cd488a2b4470fbec454651e047088dbe3382136be50531` (block 4,582,114).
- Expected: a Turnstile challenge, as in the browser flow. The API path is much easier for a script, but we do not know whether that is intended. The first claim went to the wrong address (see "Wallet" below), so we claimed twice.

**zcashfaucet.jinolabs.xyz (did not work)**
- Tried: the proof-of-work flow, solved by `scripts/wallet-faucet.ts`.
- Happened: HTTP 503 with `Our node did not report its height`. The faucet page showed 0 drips in 30 days.
- Expected: a TAZ drip. A liveness indicator on the ZecHub testnet list (https://zechub.wiki/using-zcash/testnet) would save the next builder time.

## Node or indexer

**`zaino.testnet.unsafe.zec.rocks:443` (did not work)**
- Tried: it as the zingo-cli `--server`, 18:33. Our research notes listed it as the testnet endpoint.
- Happened: HTTP 503.
- Expected: a working testnet endpoint at the address the docs give.

**`https://testnet.zec.rocks:443` (worked)**
- Tried: the same sync as above.
- Happened: it answered as lightwalletd v0.6.1, chain `test`, tip 4,582,121 at the time. Syncing from block 4,581,000 to tip took seconds. All our real transactions went through it.
- Note: a lightwalletd operator sees the wallet's IP address and which blocks it fetches. We have no Tor or Nym in the build.

**`zcash.rotko.net` zidecar (did not work for testnet)**
- Tried: `zcli 0.6.0 --testnet sync`, 18:23.
- Happened: this zidecar is a **mainnet** server (tip 3,541,604) and it has removed `GetHeaderProof`: `header proof fetch failed: ... GetHeaderProof removed from zidecar ... Upgrade the client (zcli/zclid newer than 0.9.0).`
- Expected: `--testnet` (accepted by 0.6.0) to reach a testnet backend, or a clear "no testnet server" error. We found no public testnet zidecar anywhere (source, docs, DNS guesses).

## SDK or wallet tool

**zcli (zecli) 0.6.0**
- Tried: `cargo install zecli`, `--testnet`, `--json`, `-i <ssh key>`. Key derivation and `address` work offline.
- Happened: sync fails against the only zidecar (see above). We could not send.
- Expected: end-to-end testnet use, since the docs mention `--testnet`.

**zcli 0.10.0 (GitHub release, sha256 verified)**
- Tried: the newer build, as the error above suggested.
- Happened: it says "use mainnet (always true; testnet not supported yet)". It is mainnet-only.
- Expected: testnet support, or a note on the release page. Result: zcli cannot do testnet, so we dropped it as the primary wallet at 18:24. The adapter (`src/wallet/zecli.ts`) is kept and unit-tested.

**zcli ssh-key wallet derivation**
- Tried: a wallet from a dedicated ssh ed25519 key, which is the agent-friendly path in the zcli docs.
- Happened: the address is derived with a legacy scheme (BLAKE2b of the ssh seed) that no other wallet can import. The first 1 TAZ we sent to that address (`utest1j9jdm...`) is stranded, because only zcli can spend it.
- Expected: either a standard BIP39 seed, or a loud warning that the wallet is not portable. We switched to a BIP39 mnemonic; `zcli --testnet --mnemonic` and zingo-cli then derived the same address.

**zingo-cli (zingolib `dev` branch, commit `3f2529e2` of 2026-11-02, built in Docker)**
- Tried: the build (`docker/zingo.Dockerfile`, about 5 minutes on 8 cores) and then `zingo-cli --waitsync <command>`.
- Happened: `--waitsync` never returns in this build, because the sync task never reports completion. Driving the REPL over stdin works: `sync`, then the command, then `quit`. Our adapter (`src/wallet/zingo.ts`) does that.
- Expected: `--waitsync` to exit when sync finishes. Also, the CLI prints banners mixed with JSON, so we wrote a small balanced-brace parser.
- Worked well: `--viewkey` imports a UFVK as a view-only wallet. It reports `wallet_kind: Loaded from unified full viewing key` and decrypts incoming amounts and memos. This is what our gateway is built on.

## Wallet

**Change is locked for 3 confirmations**
- Tried: back-to-back sends from one wallet.
- Happened: after a send, the change is not spendable until 3 confirmations (`min_confirmations: 3`), about 1.5 to 4 minutes at testnet block times (25 to 75 s). The next send has to wait for that.
- Expected: some way to spend change sooner, or a clear "funds pending, n blocks left" message. We worked around it by splitting the funds into 6 notes of 0.05 TAZ with one self-send (`bun run wallet:split`) before each take.

**Pools and NU7 v6 transactions**
- Tried: reading balances and notes from `zingo-cli` after the testnet network upgrades.
- Happened: our 1 TAZ showed up in the new `ironwood` pool, not Orchard (`notes all` prints `ironwood_notes`, `orchard_notes`, `sapling_notes`). The explorer labels our transactions as v6 shielded with 0 public inputs and outputs. Our parser had to learn the new pool name.
- Expected: older docs and tools only mention Sapling and Orchard. A short note on which pools appear after NU6.3 and NU7 would help.

**One session per wallet**
- Happened: two `zingo-cli` processes cannot safely open the same wallet directory. We added a lock (`.zr-session.lock`) so the web server and the CLI wait for each other.

## Docs

- The ZecHub testnet page lists faucets without saying whether they work today (jinolabs was down). See the faucet items above.
- Our research listed `zaino.testnet.unsafe.zec.rocks` as the testnet endpoint (503 when we used it). We used `testnet.zec.rocks` instead.
- The zcli docs mention `--testnet` and ssh-key wallets, but neither the sync backend limits nor the derivation caveat are written down. See the zcli items above.
- We would have liked a short "agent wallet on testnet" recipe: which tool, which endpoint, which faucet, how to read a memo back.

## Other

- Explorer: `testnet.zcashexplorer.app` shows only a shielded tx and its fee, which is what we wanted to show. Plain `curl` gets HTTP 403, so verification needs a browser.
- Memos: ZIP-302 memos (`ZR1|<invoice>|<policy_hash8>`) were readable on the receiving side with a viewing key. This is the basis of the gateway.
- We could not find a hosted testnet merchant tool for UFVK-based verification that fits a Bun backend, so the gateway watches a view-only `zingo-cli` wallet itself. CipherPay's testnet sandbox (https://testnet.cipherpay.app) is a UFVK-based merchant tool that appears in our research. We did not try it.
