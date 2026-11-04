# Video script (2:00 maximum)

Read slowly. About 2 words per second, with pauses at the cuts. Narration total is about 210 words. If you run long, drop the sentences marked (optional).

Placeholders: replace `{{ZEC_TXID}}` with the real testnet txid in shot 5 (open the explorer URL before recording).

## Pre-recording checklist

1. Time: finish recording by 22:30 IST.
2. `cd /home/lechuuu/hackathons/freesociety/app`
3. Reset the ledger so the budget shows ₹1,000: `bun run demo -- --reset-ledger`
4. Environment for the recording (set in `.env` or the shell). With the real wallet:
   `ZEC_WALLET=zingo ZEC_NETWORK=testnet BITREFILL_MODE=offline AGENT_MODE=scripted` (use `BITREFILL_MODE=test` only if the key works and a test order succeeded earlier today).
   If the wallet is not ready, use `ZEC_WALLET=mock` and do not show it as a real send; show the pre-made txid page instead and say it is from an earlier run.
5. Check the wallet has TAZ: `ZEC_WALLET=zingo bun run wallet:selftest -- --memos-only`
6. Start the server: `bun run serve` and open `http://localhost:3000`. Zoom the browser to 125%.
7. Open in other tabs: the testnet explorer page `https://testnet.zcashexplorer.app/transactions/{{ZEC_TXID}}`, and `data/policy.json` in an editor.
8. Open a terminal with a large font, in the app folder, ready for `ZEC_WALLET=zingo bun run wallet:selftest`.
9. Do one dry run of each preset, then reset the ledger again (step 3).
10. Close chat, email and notification windows. Make sure no `.env` or key is on screen.

## Shot list

| Time | Shot (what is on screen) | Narration (read exactly) |
|---|---|---|
| 0:00 to 0:12 | Title card: "ZecRecharge". Then the web UI home with the mandate panel (₹1,000 left). | "Zcash has private rails, but few shops accept it. And AI agents need money with limits. ZecRecharge is an agent that buys from Bitrefill with shielded ZEC, inside a budget it cannot override." |
| 0:12 to 0:30 | Click preset **₹239 Jio**. Timeline step 1: search results appear, badge REAL. | "I type: recharge my phone with two hundred thirty-nine rupees Jio. The agent searches Bitrefill live, using the hosted MCP. This step is real." |
| 0:30 to 0:42 | Step 2 turns green: "allowed", no confirm. Budget meter drops to ₹761. | "The policy gate checks the budget, the allow-list and the category cap. Small amount, so it is approved automatically." |
| 0:42 to 0:56 | Click preset **₹700 Amazon Pay**. Confirm card appears. Click Confirm. | "Now seven hundred rupees. That is above my limit, so the agent must wait. I click Confirm. Without my click, nothing can be paid." |
| 0:56 to 1:06 | Click preset **₹1,500 Flipkart**. Red "denied" card with the reason. | "Fifteen hundred rupees is over the cap. It is denied, and no one can override it, not even the model." |
| 1:06 to 1:28 | Switch to terminal: run `ZEC_WALLET=zingo bun run wallet:selftest`. Show the output: txid, memo `ZR1|…|…`. | "Next, the payment. The agent sends a shielded Zcash transaction on testnet. The memo holds the Bitrefill invoice id and a hash of the policy. The wallet decrypts it, so you can see it here." |
| 1:28 to 1:38 | Browser tab: testnet explorer page for `{{ZEC_TXID}}`. | "Here is the same transaction on the testnet explorer. Amount and memo are hidden on chain." |
| 1:38 to 1:50 | Back to the UI, run timeline: step 4 QUOTE badge, step 6 FIXTURE or TEST badge. Point to the legend. | "The swap to USDC is only a quote. The order is a test or fixture, and the badges say so. We never call a fake a payment." |
| 1:50 to 2:00 | Show the audit ledger panel, then the card: "30 days: real mainnet swap + Telegram". | "Honest status: shielded send and policy gate are real. Next, we make the swap real on mainnet. ZecRecharge. Thank you." |

## Notes for the presenter

- Say "testnet" clearly in shot 6. The judges need to hear it.
- If the Bitrefill key works and the deliver step shows a test code, add in shot 8: "This order is a free Bitrefill test product." If not, say "fixture" as written.
- If a step is slow, keep talking over it; do not cut to a different run. Use only runs from this recording session so the ids match.
- Pronunciation: "Zcash" (zee-cash), "Bitrefill" (bit-ree-fill), "shielded" (sheel-did), "mandate" (man-date).
- Export as MP4, upload as YouTube unlisted or Drive with link access, then paste the link into `{{VIDEO_URL}}` in the README and the form.
