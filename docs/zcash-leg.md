# Zcash leg — shielded testnet payments (T1)

**Status (2026-11-04 18:44 IST): REAL.** ZecRecharge sends shielded testnet ZEC (TAZ) with an encrypted
memo, and reads the memo back from its own wallet. Backend: **zingo-cli** (Docker) against the public
testnet lightwalletd `https://testnet.zec.rocks:443`. `ZEC_WALLET=zingo`.

## Evidence

| what | value |
|---|---|
| network | Zcash **testnet** (NU6.3 active, funds sit in the new Ironwood shielded pool) |
| our address (UA) | `utest1fwm0cc2hugw4vuvfxdh8lm9m4ncq7ppgcnem98062ka8gtuuc5jyhemud5mtc6n8whflxldzg8tn66mc86nktgm33fkvt8djus4urx96` |
| funding (fauzec.com faucet, 1 TAZ) | `22a9c727bf2a375772cd488a2b4470fbec454651e047088dbe3382136be50531` (block 4,582,114) |
| **shielded send #1** (self-transfer 10,000 zat) | **`a22ea50b38362055befe1089d7f7d7d5203eba2f3efc61010934af7fe91e92ab`** |
| explorer | https://testnet.zcashexplorer.app/transactions/a22ea50b38362055befe1089d7f7d7d5203eba2f3efc61010934af7fe91e92ab |
| mined | block 4,582,144; explorer: "Tx Type: Shielded", public inputs/outputs 0/0, v6 tx, fee 0.0001 TAZ |
| memo (plaintext, decrypted by our wallet) | `ZR1|selftest-1840|7622af6e` |
| how | zingo-cli REPL `quicksend <ua> 10000 "ZR1|selftest-1840|7622af6e"`, memo read back with `notes all` |

The explorer shows no amounts, addresses or memo — only that a shielded transaction happened.
The memo is readable only with our viewing key (`notes all` output, scope `external`, value 10,000).

`bun run wallet:selftest` (see below) repeats the whole loop through the TypeScript adapter;
its runs are appended to the table in "Selftest runs".

## Memo convention

`ZR1|<bitrefill_invoice_id>|<policy_hash8>` — `ZR1` = ZecRecharge v1; `policy_hash8` = first 8 hex of
sha256 of the policy file that approved the payment (so the on-chain, encrypted memo commits to the
mandate). Helpers: `formatMemo()`, `parseMemo()` in `src/wallet/util.ts`. Max 512 bytes (ZIP-302).

## Why zingo-cli and not zecli (the planned primary)

1. `zcli` 0.6.0 (crates.io, the last build with `--testnet`) syncs against zidecar
   `https://zcash.rotko.net`, which is **mainnet** (tip 3,541,604) and has **retired** the
   `GetHeaderProof` RPC: `{"error":"header proof fetch failed: ... GetHeaderProof removed from zidecar ... Upgrade the client (zcli/zclid newer than 0.9.0)."}`
2. `zcli` 0.10.0 (GitHub release, sha256 `766e419e…ce11` verified) has dropped testnet:
   its help says "use mainnet (always true; testnet not supported yet)".
3. No public **testnet** zidecar exists (none in the zecli source, docs or DNS guesses).
   → zecli can derive our testnet address but cannot sync or send on testnet.
   `src/wallet/zecli.ts` is still implemented and unit-tested (command runner injected), and works
   on testnet if `ZCLI_ENDPOINT` ever points at a testnet zidecar.
4. zcli's ssh-key wallets use a legacy derivation (BLAKE2b of the ssh seed) that no other wallet can
   import, so we created a standard **BIP39 mnemonic** wallet instead. `zcli --testnet --mnemonic`
   and zingo-cli derive the **same** address from it (checked).

## zingo-cli setup

- Image: `docker/zingo.Dockerfile` — zingolib `dev` @ `3f2529e2` (2026-11-02), built **without** the
  Nym mixnet and **with** `nakednet-test-mode` so the CLI can go online with a direct gRPC connection.
  Build: `sudo docker build -f docker/zingo.Dockerfile -t zecrecharge/zingo-cli docker/` (~5 min on 8 cores).
- Wrapper: `scripts/wallet-zingo.sh` — runs the image with `--chain testnet --server https://testnet.zec.rocks:443`
  and the wallet dir `app/.secrets/zingo-testnet/` (chmod 700). On first run it restores the wallet from
  `app/.secrets/zcash_mnemonic.txt` at birthday 4,581,000 (`ZINGO_SEED` env, never argv).
- Quirk: `zingo-cli --waitsync <command>` never returns in this build (the sync task never reports
  completion). The adapter therefore drives the **interactive prompt over stdin**: one session per
  operation → poll `sync status` until every scan range is `Scanned` up to this session's tip →
  run the command → `quit`. (`src/wallet/zingo.ts`, class `ZingoSession`.)
- Spending needs 3 confirmations (`min_confirmations: 3`), so after a send the change is not
  spendable for ~1–2 minutes (testnet block time is ~25–75 s).
- `zaino.testnet.unsafe.zec.rocks:443` (listed on hosh.zec.rocks) answered HTTP 503 today;
  `testnet.zec.rocks:443` (ECC lightwalletd v0.6.1) works.

### Commands used (copy-paste)

```bash
cd app
# key material (gitignored, chmod 600)
ssh-keygen -t ed25519 -N "" -f .secrets/zcash_ed25519            # zcli identity (legacy derivation)
# .secrets/zcash_mnemonic.txt = 24-word BIP39 phrase (generated with @scure/bip39)
ZCLI_MNEMONIC="$(cat .secrets/zcash_mnemonic.txt)" zcli-0.6.0 --testnet --json address
# fund (fauzec.com has a JSON API; no captcha needed when called directly)
curl -s -X POST https://fauzec.com/api/v1/claim -H 'content-type: application/json' \
  -d '{"address":"utest1fwm0cc...urx96","network":"testnet"}'
# build + run zingo-cli
sudo docker build -f docker/zingo.Dockerfile -t zecrecharge/zingo-cli docker/
scripts/wallet-zingo.sh --nosync addresses
printf 'sync status\nspendable_balance\nquit\n' | scripts/wallet-zingo.sh
printf 'sync status\nquicksend utest1fwm0cc...urx96 10000 "ZR1|selftest-1840|7622af6e"\nquit\n' | scripts/wallet-zingo.sh
printf 'notes all\nmessages\nquit\n' | scripts/wallet-zingo.sh --nosync
# whole loop through the TS adapter
ZEC_WALLET=zingo bun run wallet:selftest -- --invoice <id> [--to <utest1...>] [--amount 10000]
```

## Adapter API (`src/wallet/`)

`createWallet()` (env `ZEC_WALLET=zingo|zecli|manual|mock`, default `mock`) returns a `Wallet`:
`getAddress()`, `getBalance() -> {spendableZat}`, `send(to, amountZat, memo) -> ShieldedSend`,
`waitConfirmed(txid, timeoutMs) -> boolean` (public explorer first, own wallet as fallback),
`readMemos() -> [{txid, memo, amountZat?, height?}]`.

| mode | real? | notes |
|---|---|---|
| `zingo` | **real testnet** | Docker zingo-cli; needs `sudo -n docker` (or docker group) |
| `zecli` | addresses only on testnet | no testnet zidecar; see above |
| `manual` | real, but sent by a human | `WALLET_TXID_OVERRIDE=<txid>` (+ optional `WALLET_MEMO_OVERRIDE`, `ZEC_ADDRESS`); labelled "manual"; confirmations checked on the explorer |
| `mock` | **no** | txid `mock-…`, explorer `mock://…`, mode `mock` |

`ShieldedSend.mode` in `src/types.ts` has no `"mock"`; the wallet exports `WalletSend` (same shape,
`mode` widened with `"mock"`) instead of editing the frozen contract.

## Privacy notes (input for the README threat model)

- The chain sees a v6 shielded transaction with 0 public inputs/outputs: no sender, receiver, amount
  or memo. Only the fee is public.
- The lightwalletd operator (`testnet.zec.rocks`) sees our **IP address** and when we sync/broadcast.
  This build deliberately runs *without* zingo's Nym mixnet ("nakednet") for speed; zingo-cli prints a
  warning saying so. Mainnet use should keep the mixnet (the default build) or use Tor.
- The memo commits to the invoice id and the policy hash, but is encrypted to the recipient; Bitrefill
  never sees our Zcash addresses.

## Selftest runs

| time (IST) | command | txid | confirmed | memo read back |
|---|---|---|---|---|
| 18:40 | REPL `quicksend` (manual) | `a22ea50b38362055befe1089d7f7d7d5203eba2f3efc61010934af7fe91e92ab` | block 4,582,144 | `ZR1|selftest-1840|7622af6e` |
| 18:43 | `ZEC_WALLET=zingo bun run wallet:selftest -- --invoice selftest-ZR-T1` (exit 0, 43 s end-to-end) | `e842278faf78e217f4153875a47b9f423837a4d50c7575bb32136bb59877aa87` | block 4,582,147 | `ZR1|selftest-ZR-T1|847f2a37` |

Explorer: https://testnet.zcashexplorer.app/transactions/e842278faf78e217f4153875a47b9f423837a4d50c7575bb32136bb59877aa87
(`847f2a37` = sha256("zecrecharge-selftest") because `data/policy.json` did not exist yet; with a policy
file present the selftest hashes that file.)
