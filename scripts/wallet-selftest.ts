// bun run wallet:selftest [-- --to <addr>] [--amount <zat>] [--invoice <id>] [--policy <file>] [--timeout <sec>] [--no-wait] [--memos-only]
//
// End-to-end check of the configured wallet (ZEC_WALLET=zingo|zecli|manual|mock):
// address -> balance -> shielded send with memo ZR1|<invoice>|<hash8> -> wait for 1 confirmation
// -> read the memo back from the wallet's own decrypted notes. Default recipient = our own
// address (a shielded self-transfer), so the memo can be decrypted by this same wallet.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWallet, formatMemo } from "../src/wallet";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const kind = process.env.ZEC_WALLET || "zingo";
const wallet = createWallet(kind);
const banner = wallet.mode === "mock" ? "MOCK (no real transaction)" : wallet.mode === "manual" ? "MANUAL (human-sent txid)" : "REAL testnet";
console.log(`== wallet selftest: mode=${wallet.mode} network=${wallet.network} [${banner}]`);
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const address = await wallet.getAddress();
console.log(`address      ${address}`);

if (flag("memos-only")) {
  const memos = await wallet.readMemos();
  console.log(JSON.stringify(memos, null, 2));
  process.exit(0);
}

const bal = await wallet.getBalance();
console.log(`spendable    ${bal.spendableZat} zat (${(bal.spendableZat / 1e8).toFixed(8)} TAZ)  [${elapsed()}]`);

const amountZat = Number(arg("amount") ?? 10_000);
const to = arg("to") ?? address;
const invoiceId = arg("invoice") ?? `selftest-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
const policyPath = arg("policy") ?? process.env.POLICY_FILE ?? join(import.meta.dir, "..", "data", "policy.json");
const policyBytes = existsSync(policyPath) ? readFileSync(policyPath) : Buffer.from("zecrecharge-selftest");
const hash = createHash("sha256").update(policyBytes).digest("hex");
const memo = formatMemo(invoiceId, hash);
console.log(`sending      ${amountZat} zat -> ${to === address ? "self (" + to.slice(0, 16) + "...)" : to}`);
console.log(`memo         ${memo}`);

const sent = await wallet.send(to, amountZat, memo);
console.log(`txid         ${sent.txid}   [${elapsed()}]`);
console.log(`explorer     ${sent.explorerUrl}`);
console.log(`mode         ${sent.mode}`);

if (flag("no-wait")) process.exit(0);

const timeoutMs = Number(arg("timeout") ?? 900) * 1000;
const ok = await wallet.waitConfirmed(sent.txid, timeoutMs);
console.log(`confirmed    ${ok}   [${elapsed()}]`);

const memos = await wallet.readMemos();
const mine = memos.filter((m) => m.txid === sent.txid);
if (mine.length) {
  for (const m of mine) console.log(`memo read    ${m.memo}  (txid ${m.txid.slice(0, 16)}..., ${m.amountZat ?? "?"} zat, height ${m.height ?? "?"})`);
} else {
  console.log(`memo read    (no note with a memo for this txid in this wallet${to === address ? "" : " — recipient is another wallet"})`);
}
console.log(JSON.stringify({ ...sent, confirmed: ok, memoReadBack: mine[0]?.memo ?? null, invoiceId }));
process.exit(ok && (to !== address || mine.some((m) => m.memo === memo)) ? 0 : 1);
