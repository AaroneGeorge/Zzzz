# Integration: the real end-to-end flow and the shielded payment gateway

Status on 2026-11-04 at 19:05 IST: **working for real**. Every run below was made with
`AGENT_MODE=llm ZEC_WALLET=zingo BITREFILL_MODE=test` and the real Bitrefill API key. Each one had a live Bitrefill
search, a live NEAR Intents 1Click dry quote, the real policy gate, a REAL shielded testnet payment from the agent
wallet to the gateway, gateway verification through a **view-only (UFVK) wallet**, and then a REAL Bitrefill
**test-product** order. That order was placed only after the payment had been verified.

## What changed in the flow

The flow now has 7 steps, where it used to have 6. The ZEC payment now *causes* the purchase; it is no longer a
self-transfer.

| # | Step | Tool | Mode in a real run |
|---|------|------|--------------------|
| 1 | Search Bitrefill | `search_products` | `real` (live Bitrefill search) |
| 2 | Policy gate | `request_approval` | `real` (the code gate), or `manual` when a human confirms |
| 3 | Quote ZEC → USDC (NEAR Intents) | `quote_bridge` | `quote` (live 1Click dry quote; nothing is swapped) |
| 4 | Gateway invoice (shielded payment request) | `place_order(create)` | `test` (testnet gateway) |
| 5 | Shielded ZEC payment to the gateway | `pay_shielded` | `test` (real testnet tx) |
| 6 | **Gateway verified shielded payment (viewing key)** | inside `place_order(confirm)` | `test` |
| 7 | Place Bitrefill order (only after verification) | `place_order(confirm)` | `test` (real Bitrefill test product) |

- The quote now runs **before** the invoice, because the gateway prices its invoice from the quote.
- `place_order(confirm)` first runs the gateway verification in code. The LLM cannot skip it. Only a verified
  payment, meaning the memo matches the invoice id, the amount is at least the expected amount, and the
  transaction is mined, creates the Bitrefill invoice. That invoice is a test product, paid with
  `payment_method=balance` and `auto_pay`. If verification times out, step 6 fails, step 7 is skipped with
  "NOT placed …", and **no Bitrefill call is made**. This was tested live; see run 5 below.
- The gateway uses a view-only wallet. `.secrets/zingo-gateway` is the gateway's full wallet, made from a new
  24-word mnemonic in `.secrets/gateway_mnemonic.txt` (birthday 4,582,051). Its UFVK (`.secrets/gateway_ufvk.txt`)
  was imported with `zingo-cli --viewkey` into `.secrets/zingo-gateway-view`. Only that view-only wallet is polled,
  and it cannot spend. `wallet_kind` reports "Loaded from unified full viewing key". Gateway address:
  `utest1u2fv2k87x7370mw88j3hst9cd4qnz9cw3pya2xu4h80u6zwms25qcn6zfw5909wnpnws2l6rzf42z70lvn5d37wzz72ker9ak56w9yke`.
- The UI shows `gateway: view-only UFVK` as a chip. Step 6 lists the privacy facts (✓ or ✕):
  - The amount, sender, recipient and memo are encrypted on chain.
  - The gateway decrypts them with its viewing key.
  - The gateway never learns the agent's address.
  - Bitrefill sees only the order.
  - Caveat: lightwalletd sees our IP, because this build has no mixnet.
- The UI and CLI show latency honestly. Step 5 shows "Broadcasting: zingo-cli syncs, builds the shielded proof
  and broadcasts … (≈30–60 s)". It then shows "broadcast, waiting for a block", and after verification
  "mined at height N". Step 6 shows "Gateway sees tx … in the mempool · waiting for it to be mined (N s, poll k)".
  The server runs each run asynchronously, so the UI stays responsive and SSE keeps streaming.
- **Testnet price.** The testnet amount is the quoted mainnet ZEC × `GATEWAY_TESTNET_SCALE` (default 1), rounded
  to 1,000 zat and clamped to 0.001–0.01 TAZ. The UI labels it "testnet stand-in: quoted X ZEC (mainnet) × 1 = Y
  TAZ". Example: ₹239 is quoted at 0.00225 ZEC, so 0.00226 TAZ is sent. ₹700 is quoted at 0.00657 ZEC, so 0.00657
  TAZ is sent. If the quote fails, the run falls back to 0.001 TAZ and says so.
- **Cross-process wallet lock.** Every zingo session takes `<wallet dir>/.zr-session.lock` (an atomic `mkdir`; a
  lock older than 10 minutes counts as stale). The web server and the CLI can therefore run at the same time
  without two zingo-cli processes opening the same wallet.

New files:
- `src/gateway/{types,matcher,watcher,zingo-source,index}.ts` and `gateway.test.ts`
- `scripts/gateway-selftest.ts` (`bun run gateway:selftest`)
- `scripts/wallet-split.ts` (`bun run wallet:split`)

Changed files:
- `src/agent/{state,deps,tools,index,llm}.ts`
- `src/web/{server.ts,index.html}`
- `src/cli.ts`
- `src/wallet/zingo.ts` (the lock)
- `.env.example`
- `package.json` (scripts only)

## Commands for the full real demo

```bash
cd /home/lechuuu/hackathons/freesociety/app
# BITREFILL_API_KEY and ANTHROPIC_API_KEY come from .env (bun loads it automatically)
export AGENT_MODE=llm ZEC_WALLET=zingo BITREFILL_MODE=test      # gateway defaults to ufvk with ZEC_WALLET=zingo

bun run demo -- --reset-ledger                                   # fresh ₹1,000 budget
bun run serve                                                    # http://localhost:3000, then click the presets
#   ₹239 Jio          → auto-approved → 7/7 OK in ~1.5–2.5 min
#   ₹700 Amazon Pay   → Confirm card → click Confirm → 7/7 OK
#   ₹1,500 Flipkart   → DENIED by the gate (above the per-purchase cap), nothing sent

# the same from the CLI (do not run a CLI payment while a web run is paying; the lock makes it wait)
bun run demo -- "Recharge +919999999999 with ₹239 Jio"
bun run demo -- --yes "₹700 Amazon Pay gift card for my mom"

# component checks
bun test                                                         # 92 pass
ZEC_WALLET=zingo bun run gateway:selftest                        # agent → gateway, UFVK verifies (~1.5 min)
BITREFILL_MODE=test bun run bitrefill:selftest                   # v2 ping + free test order
```

Without keys or Docker the same flow runs with labelled mocks:
`AGENT_MODE=scripted ZEC_WALLET=mock BITREFILL_MODE=offline bun run demo -- "…"`.
In that mode the gateway is `mock` and the steps are labelled `mock` or `fixture`.

## Evidence: real runs (testnet)

All shielded txs went from the agent wallet (`utest1fwm0cc…urx96`) to the gateway (`utest1u2fv2k…k56w9yke`), and the
gateway's view-only wallet decrypted the memo and amount. Explorer:
`https://testnet.zcashexplorer.app/transactions/<txid>`.

| # | time (IST) | how | request | gateway invoice / memo | TAZ | shielded txid | height | Bitrefill invoice / order (TEST product) |
|---|---|---|---|---|---|---|---|---|
| 1 | 18:52 | CLI, llm | ₹239 Jio | `zrg-32241-duly-3d1ace` / `ZR1\|zrg-32241-duly-3d1ace\|e6854938` | 0.001 (old scale 0.1, clamped) | [`e2959ddaea078e7a40a6f1bde2304f1635c611cd699adee8f849dbc368a751ce`](https://testnet.zcashexplorer.app/transactions/e2959ddaea078e7a40a6f1bde2304f1635c611cd699adee8f849dbc368a751ce) | 4,582,164 | `e6fcf0ea-739f-41bb-b6a1-e968b4bbde35` / `6aeb31f068f1cc1b9af1659d` (test-phone-refill, delivered) |
| 2 | 18:54 | web UI, llm, human Confirm | ₹700 Amazon Pay | `zrg-32415-c32y-0542e7` | 0.00658 | [`0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f`](https://testnet.zcashexplorer.app/transactions/0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f) | 4,582,167 | `0fb6f4db-6f80-4f76-8699-c4b5edf067f1` / `6aeb326986d3593f50960265` (test-gift-card-code, delivered) |
| 3 | 18:58 | web UI, llm, human Confirm | ₹700 Amazon Pay | `zrg-32809-7oek-fc87b5` | 0.00657 | [`c7567271ec204f1712d8febe52d89600c1c0aefe7cddd202693ab659cfb4ebec`](https://testnet.zcashexplorer.app/transactions/c7567271ec204f1712d8febe52d89600c1c0aefe7cddd202693ab659cfb4ebec) | 4,582,177 | `10602ded-b82a-49a8-8a21-d3d32e2a5c86` / `6aeb335d86d3593f50961258` (delivered) |
| 4 | 19:00 | CLI, llm, **back-to-back** with run 3 | ₹239 Jio | `zrg-33029-3o6s-0d47f4` | 0.00226 | [`c03241ccdeb57bb191380733261dea8e4c2026aef1064b25c88476d823df912f`](https://testnet.zcashexplorer.app/transactions/c03241ccdeb57bb191380733261dea8e4c2026aef1064b25c88476d823df912f) | 4,582,182 | `fe08a9bd-e913-4ca3-8aa4-54527a6e02bc` / `6aeb33f586d3593f50961f38` (delivered) |
| 6 | 19:03 | web UI, llm (after the lock change; screenshot `docs/img/ui-gateway-run.png`) | ₹239 Jio | `zrg-33343-4z1a-d40f49` | 0.00226 | [`3ffdc96d63dba1c92afe157ee47281b0dc883d028c6999db40a1cefe47ebc5fc`](https://testnet.zcashexplorer.app/transactions/3ffdc96d63dba1c92afe157ee47281b0dc883d028c6999db40a1cefe47ebc5fc) | 4,582,188 | `db3d86b9-3bd9-4512-811e-21d9a7b8b1a4` / `6aeb348268f1cc1b9af19803` (delivered) |
| 5 | 19:03 | CLI, scripted, `GATEWAY_TIMEOUT_MS=8000` (**negative test**) | ₹99 Jio | `zrg-33253-t5u2-ee0a77` | 0.001 | [`92cdb323eb15211576b4d2db6d6a31cd38ced754d2ae88bbf5a4bc1950eb32e0`](https://testnet.zcashexplorer.app/transactions/92cdb323eb15211576b4d2db6d6a31cd38ced754d2ae88bbf5a4bc1950eb32e0) | (seen in mempool only) | **none**: "NOT placed: the gateway did not verify …" |

Other real txs:
- Gateway selftest at 18:56: [`d07f81fc9fd922deeead4f10bb5a015574fa411d1b852e9958300074c1148a18`](https://testnet.zcashexplorer.app/transactions/d07f81fc9fd922deeead4f10bb5a015574fa411d1b852e9958300074c1148a18),
  0.001 TAZ, verified by the UFVK wallet at height 4,582,172 in 85 s.
- Note split at 18:49 (6 × 0.05 TAZ to self): [`95aed0584f9746c0d2260d829b93c6edf1d7022f403dc0da41aba55f2bcd2a36`](https://testnet.zcashexplorer.app/transactions/95aed0584f9746c0d2260d829b93c6edf1d7022f403dc0da41aba55f2bcd2a36).

Runs 1–4 and 6 each took about 1.5–2.5 minutes from the first step to delivery. Testnet blocks came every 30–75 s.
Bitrefill account balance before and after was 0 BTC; test products are free.
A live policy denial was also checked: ₹99 when ₹61 was left gave "DENIED … would exceed the daily budget", and nothing was sent.

## What is real and what is labelled

| Piece | Real? | Label in the UI and CLI |
|---|---|---|
| Bitrefill product search | real, live v2/MCP | `real` |
| Policy gate, ledger, policy hash in the memo | real code | `real` / `manual` (human click) |
| NEAR Intents 1Click quote | live **dry** quote, nothing swapped; falls back to a fixture if 1Click errors (for example on tiny amounts) | `quote` / `fixture` |
| Gateway invoice | real gateway logic, testnet | `test` |
| Shielded payment | **real testnet tx**: TAZ, not ZEC; the amount is a testnet stand-in for the quoted mainnet ZEC | `test` |
| Gateway verification | **real**: a view-only UFVK wallet decrypts memo and amount on testnet | `test` |
| Bitrefill order | **real Bitrefill API order of a free TEST product** (`test-phone-refill`, `test-gift-card-code`); the matched real Indian product (for example `reliance-jio-india-bundles`) is shown but not bought | `test` |
| ZEC → USDC settlement to Bitrefill | **not done**: quote only (mainnet, no funds) | `quote` |

## Pre-recording checklist

1. Run `date`. Make sure no other ZecRecharge process is paying: `ls .secrets/zingo-testnet/.zr-session.lock`
   should not exist. If a crashed run left it behind, delete it, or wait 10 minutes for it to go stale.
2. Run `bun run demo -- --reset-ledger`, so the mandate panel shows ₹1,000 left. Restart `bun run serve` afterwards:
   the UI run list is in memory.
3. **Make sure several notes are spendable.** Change needs 3 confirmations, about 1.5–4 minutes. The split at
   18:49 left six 0.05 TAZ notes, and runs 3 and 4 went back to back without waiting. Before recording, run:
   ```bash
   bun run wallet:split -- 6 5000000      # one tx, 6 × 0.05 TAZ notes to self
   ```
   Then **wait about 5 minutes** (3+ blocks) before the first take. Repeat it after every 4–5 takes. The total balance was
   0.978 TAZ at 19:05 (0.899 TAZ spendable right then).
4. **Warm up the sync**, so the first broadcast isn't slowed by catching up. Do this only while no run is active,
   because the raw script bypasses the lock:
   ```bash
   printf 'sync status\nspendable_balance\nquit\n' | scripts/wallet-zingo.sh 2>/dev/null | tail -5
   ZINGO_DATA_DIR=$PWD/.secrets/zingo-gateway-view ZINGO_SEED= scripts/wallet-zingo.sh --nosync wallet_kind
   ```
   `spendable_balance` should be at least 0.01 TAZ. The gateway view wallet should report "Loaded from unified full
   viewing key".
5. Optional one-shot check, about 1.5 minutes and 0.001 TAZ: `ZEC_WALLET=zingo bun run gateway:selftest`.
6. Start the server with the real env (see above) and check the chips: `agent llm`, `bitrefill test`,
   `wallet zingo`, `gateway view-only UFVK`.
7. During the take, the pay step takes 20–60 s and the verify step 15–90 s. Narrate over it: "the gateway sees it
   in the mempool… mined at height N… only now does Bitrefill get the order".
8. Open the explorer link from step 5 or 6. The page shows only a shielded tx and its fee. If the explorer is slow,
   open it ahead of time in another tab. Plain `curl` gets HTTP 403 from the explorer, so check it in a browser.

## Gotchas found during integration

- Do not kill processes with `pkill -f "<pattern>"` in a shell whose own command line contains that pattern; it
  kills the shell itself. Find the server by its port instead: `ss -ltnp | grep :3000`.
- With the key, v2 search for "Amazon" returns only "Amazon Fresh India" packages. The Amazon Pay preset therefore
  shows "matched: amazon-fresh-india" and buys `test-gift-card-code`. It is honest, but it doesn't look ideal on
  video. This is logged in `bitrefill-feedback.md`.
- 1Click returned an error for ₹99 (likely below its minimum). The quote step then fell back to a labelled
  `fixture`, and the gateway used the 0.001 TAZ default.
