# Video script (2:00 maximum, captions only, no voice)

The final cut is built from on-screen captions. It can be produced by hand or by a script, with or without audio. Each caption stays up 3 to 6 seconds, in large type, at the bottom third of the screen. Use short sentences.

**The wait.** Steps 5 and 6 (pay and verify) take about 1.5 to 2.5 minutes in real time (testnet blocks come every 30 to 75 s). Do not show it all. Record the full run, then in the edit **speed up 8x (or cut) the wait** between "broadcast" and "mined at height N". Keep a visible caption on screen during the cut: **"Sped up: the real wait was about 2 minutes (testnet blocks)."** Do not hide the cut, and keep the step timeline visible so the viewer sees it is the same run.

Placeholder: the final cut shows the txid `0863ac3207142f08e974f28e03bd0f67f2587c12607db4267d628d40505fa93f` (explorer page for it opened in a browser tab beforehand; plain `curl` gets HTTP 403).

## Pre-recording checklist

Full version in `docs/integration.md`. Finish recording well before the 00:00 IST deadline.

1. `cd /home/lechuuu/hackathons/freesociety/app`; check `ls .secrets/zingo-testnet/.zr-session.lock` does not exist.
2. `bun run demo -- --reset-ledger` so the mandate panel shows ₹1,000 left.
3. Split notes so back-to-back takes do not wait for change: `bun run wallet:split -- 6 5000000`, then wait about 5 minutes. Repeat after 4 to 5 takes.
4. Env: `export AGENT_MODE=llm ZEC_WALLET=zingo BITREFILL_MODE=test` (keys come from `.env`). Never show `.env` on screen.
5. `bun run serve`, open `http://localhost:3000` at 125% zoom. Check the chips: `agent llm`, `bitrefill test`, `wallet zingo`, `gateway view-only UFVK`.
6. Open the explorer tab for the txid above, and `data/policy.json` in an editor.
7. Do one take per preset (never mix txids from different takes in one cut). Close chat and notification windows.

## Shot list (captions)

| Time | On screen | Caption (exact text) |
|---|---|---|
| 0:00 to 0:08 | Title card, then the web UI with the mandate panel (₹1,000 left) and the chips. | "ZecRecharge: an AI agent pays shielded ZEC to a viewing-key gateway, and only a verified payment unlocks the Bitrefill order. Testnet and Bitrefill test products." / "Spending bounded by a mandate it can't override." |
| 0:08 to 0:16 | Click **₹239 Jio**. Step 1 appears, badge REAL. | "1. Search: live Bitrefill search (REAL)." |
| 0:16 to 0:24 | Step 2 turns green, budget meter drops. | "2. Policy gate, in code: budget, allow-list, caps. Small amount: auto-approved." |
| 0:24 to 0:32 | Step 3, QUOTE badge. | "3. Quote: ZEC to USDC via NEAR Intents. A dry quote: nothing is swapped (QUOTE)." |
| 0:32 to 0:40 | Step 4: gateway invoice, with the "testnet stand-in" label. | "4. Gateway invoice. Testnet amount is a stand-in for the quoted mainnet ZEC." |
| 0:40 to 0:55 | Step 5: "broadcasting", then "waiting for a block". Show the memo `ZR1\|<invoice>\|<hash8>`. | "5. The agent pays the gateway in shielded TAZ (testnet). Memo ties the payment to the invoice and the policy." |
| 0:55 to 1:15 | Step 6 with "Gateway sees tx in the mempool", poll counter. Sped-up wait. | "6. Gateway verifies with a view-only key: memo, amount, mined." / "Sped up: the real wait was about 2 minutes (testnet blocks)." |
| 1:15 to 1:25 | Step 6 turns OK: "mined at height N". Then step 7 starts. Show the privacy facts list. | "Verified. Only now is the Bitrefill order placed." / "The gateway can't spend. It never learns the agent's address." |
| 1:25 to 1:33 | Step 7 done, badge TEST, code masked. | "7. Bitrefill order: a free TEST product (TEST). No real purchase." |
| 1:33 to 1:40 | Browser tab: explorer page for `0863ac32…fa93f`. | "Same payment on the testnet explorer: shielded, block 4,582,167. Amount and memo are hidden." |
| 1:40 to 1:48 | Click **₹700 Amazon Pay**: Confirm card appears (cut straight to it). Then **₹1,500 Flipkart**: red "denied". | "Above ₹500: waits for a human Confirm." / "Above the cap: DENIED. No override." |
| 1:48 to 1:54 | Terminal or slide: the negative test. | "If the gateway can't verify in time, no order is placed. Tested live." |
| 1:54 to 2:00 | Final card. | "Testnet only. Orders are free test products. No mainnet payment." / "Next: mainnet settlement + Telegram. ZecRecharge." |

## Notes for the editor

- Every badge must stay legible (REAL, QUOTE, TEST). Do not crop them out.
- Show the Confirm click for ₹700 only as a short clip; it uses its own take and its own txid, so do not claim it is the same run. If the cut shows a second run, say so in a caption ("another run").
- If a step fails in a take (for example, the quote falls back to a labelled FIXTURE on a tiny amount), keep it in: the badge says what it is.
- The Amazon Pay preset matches `amazon-fresh-india` on Bitrefill search with a key. That is real behaviour (logged in the feedback doc); do not caption it as an Amazon Pay card purchase.
- Export MP4, upload as YouTube unlisted or Drive with link access, then paste the link into `{{VIDEO_URL}}` in the README and the form.
