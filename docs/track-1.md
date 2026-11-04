FAUCET ADDRESS: utest1fwm0cc2hugw4vuvfxdh8lm9m4ncq7ppgcnem98062ka8gtuuc5jyhemud5mtc6n8whflxldzg8tn66mc86nktgm33fkvt8djus4urx96
(already funded with 1 TAZ by T1 via the fauzec.com API at 18:27 IST - the human does NOT need to request TAZ unless told otherwise.
 Backed by the BIP39 mnemonic in app/.secrets/zcash_mnemonic.txt, so zcli --mnemonic and zingo-cli derive the same Orchard key.
 zcli-derived transparent address of the same seed (unused): tmSdSue6pKaZMbVFTS6TpxaiC5oV4QkodxT)

# Track 1 — Zcash wallet log

- 18:25 IST: created dedicated key app/.secrets/zcash_ed25519; `zcli --testnet --json address` works offline (key derivation).
- 18:25 IST: fauzec.com POST /api/v1/claim (no captcha needed via API) -> accepted, 1 TAZ, txid 6379c6211688ada82caee701d8dab378ede23191853cf0ef3d05b651436bfe68 to the zcli orchard address
- 18:23 IST: zcli 0.6.0 `--testnet sync` fails: zcash.rotko.net is a MAINNET zidecar (tip 3,541,604) and it has removed GetHeaderProof ("upgrade to zcli > 0.9.0"). zcli 0.10.0 (GitHub release, sha256 verified, installed as ~/.cargo/bin/zcli-0.10.0; ~/.cargo/bin/zcli is again 0.6.0 (also zcli-0.6.0)) says "use mainnet (always true; testnet not supported yet)". No public testnet zidecar exists -> zecli cannot do testnet. Switched to Fallback A (zingo-cli in Docker) at 18:24.
- 18:26 IST: the ssh-key wallet uses zcli's legacy derivation (BLAKE2b of the ssh seed), which no other wallet can import. Generated a BIP39 24-word mnemonic (app/.secrets/zcash_mnemonic.txt, chmod 600) instead; `zcli-0.6.0 --testnet --mnemonic ... address` gives utest1fwm0cc...urx96.
- 18:27 IST: fauzec.com claim for utest1fwm0cc...: accepted, 1 TAZ, txid 22a9c727bf2a375772cd488a2b4470fbec454651e047088dbe3382136be50531. (The earlier 1 TAZ to the ssh-key address utest1j9jdm... is stranded: only zcli could spend it.)
- jinolabs faucet (zcashfaucet.jinolabs.xyz): PoW solved by scripts/wallet-faucet.ts, but the faucet answers 503 "Our node did not report its height" (0 drips in 30 days) -> dead today.
- 18:33 IST: zingo-cli Docker image built (5 min, zingolib 3f2529e2 2026-11-02). zaino.testnet.unsafe.zec.rocks -> 503; https://testnet.zec.rocks:443 works (ECC lightwalletd v0.6.1, chain test, tip 4,582,121). Restored zingo wallet from the mnemonic at birthday 4,581,000 -> SAME address utest1fwm0cc...urx96 as zcli --mnemonic.
- 18:36 IST: `zingo-cli --waitsync <cmd>` hangs forever in this build (sync never reports completion), but the REPL driven over stdin works: synced 4,581,000..tip in seconds; spendable_balance = 100,000,000 zat (1 TAZ, in the Ironwood pool after testnet NU6.3).
- 18:40 IST: **FIRST REAL SHIELDED TESTNET SEND** (self-transfer 10,000 zat, memo `ZR1|selftest-1840|7622af6e`): txid a22ea50b38362055befe1089d7f7d7d5203eba2f3efc61010934af7fe91e92ab  https://testnet.zcashexplorer.app/transactions/a22ea50b38362055befe1089d7f7d7d5203eba2f3efc61010934af7fe91e92ab
- 18:43 IST: `ZEC_WALLET=zingo bun run wallet:selftest -- --invoice selftest-ZR-T1` -> exit 0 in 43 s: txid e842278faf78e217f4153875a47b9f423837a4d50c7575bb32136bb59877aa87, confirmed (block 4,582,147), memo `ZR1|selftest-ZR-T1|847f2a37` read back from our own notes.
- 18:44 IST: `~/.cargo/bin/zcli` restored to 0.6.0 (the brief's "supports --testnet" binary); 0.10.0 kept as zcli-0.10.0.

## Files (T1)
- src/wallet/index.ts (createWallet), types.ts (Wallet, WalletSend, WalletMode), util.ts (memo/amount/explorer helpers), zingo.ts (REAL), zecli.ts, manual.ts, mock.ts
- src/wallet/wallet.test.ts, src/wallet/zingo.test.ts (fake CLI runners, no network)
- scripts/wallet-selftest.ts (`bun run wallet:selftest`), scripts/wallet-zingo.sh (docker wrapper), scripts/wallet-faucet.ts
- docker/zingo.Dockerfile (image zecrecharge/zingo-cli, already built on this machine)
- docs/zcash-leg.md (evidence: txids, explorer links, memos, commands, privacy notes)
- secrets (gitignored): .secrets/zcash_ed25519(.pub), .secrets/zcash_mnemonic.txt, .secrets/zingo-testnet/ (wallet db)

## Test commands
- `bun test src/wallet` -> 21 pass, 0 fail (mocks + fake CLIs; no network)
- `ZEC_WALLET=mock bun run wallet:selftest` -> MOCK labelled run, exit 0
- `ZEC_WALLET=zingo bun run wallet:selftest -- --invoice <id>` -> REAL testnet send + memo read back (~45 s; needs `sudo -n docker`)

## For integration (T3 / planner)
- Use `ZEC_WALLET=zingo` for the real demo. Recipient: default our own UA (self-transfer, memo readable by us). `ZEC_DEST_ADDRESS` is not read by the wallet; pass `to` to `send()`.
- `send()` returns type `WalletSend` (= ShieldedSend with `mode` widened by `"mock"`); real modes are exactly the ShieldedSend ones.
- Only ONE zingo session can use the wallet at a time; calls are serialised inside one `ZingoWallet` instance — create the wallet once per process and don't run the selftest while the server is paying.
- After a send, change needs 3 confirmations before it is spendable again (~1–3 min). Balance now ~0.9998 TAZ (enough for ~9,000 sends of 10,000 zat + fee).
- `ZEC_WALLET=manual` + `WALLET_TXID_OVERRIDE=<64 hex>` (+ `WALLET_MEMO_OVERRIDE`, `ZEC_ADDRESS`) stays available as Fallback B.

## Human actions needed
- None for TAZ: the wallet is funded (1 TAZ from fauzec.com via its API). If more is ever needed: `bun run scripts/wallet-faucet.ts <utest1...>`, or fauzec.com in a browser (Turnstile).
- Do not commit app/.secrets/ (gitignored already).
- Side effect: zcli always keeps its state in ~/.zcli (wallet/watch sled DBs + seed_derivation marker, created 18:23-18:44 by the zcli tests). Testnet-only and harmless; delete ~/.zcli to undo.
