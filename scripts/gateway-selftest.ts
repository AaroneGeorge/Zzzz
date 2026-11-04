// Gateway selftest: the agent wallet pays the gateway's shielded address with a ZR1 memo, and the gateway
// (view-only UFVK wallet by default) must verify memo + amount + mined height. No Bitrefill call.
//   ZEC_WALLET=zingo bun run gateway:selftest [-- --amount 100000] [--timeout-min 12]   # REAL testnet (~1–3 min)
//   bun run gateway:selftest                                                         # mock wallet + mock gateway
import { createGateway } from "../src/gateway";
import { createWallet, explorerUrl, formatMemo } from "../src/wallet";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1]! : d;
};
const amountZat = Number(arg("--amount", "100000"));
const timeoutMs = Number(arg("--timeout-min", "12")) * 60_000;
const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;

const wallet = createWallet();
const gw = createGateway();
console.log(`wallet=${wallet.mode} gateway=${gw.view} address=${gw.address}`);
const inv = gw.createInvoice({ runTag: "selftest", amountZat, memoFor: (id) => formatMemo(id, "5e1f7e57"), pricing: `fixed ${amountZat} zat selftest` });
console.log(`[${secs()}] gateway invoice ${inv.id}: ${amountZat} zat, memo ${inv.memo}`);
console.log(`[${secs()}] broadcasting from the agent wallet…`);
const sent = await wallet.send(inv.address, amountZat, inv.memo);
console.log(`[${secs()}] broadcast txid ${sent.txid}${wallet.mode === "mock" ? " (MOCK)" : `\n  ${explorerUrl(sent.txid, "testnet")}`}`);
try {
  const v = await gw.waitForPayment(inv, {
    timeoutMs,
    sent: { txid: sent.txid, amountZat, memo: inv.memo, to: sent.to },
    onProgress: (p) => console.log(`[${secs()}] poll ${p.polls}: ${p.inMempool ? "in mempool, waiting for a block" : "not seen yet"}${p.lastError ? ` (error: ${p.lastError.slice(0, 100)})` : ""}`),
  });
  console.log(`[${secs()}] VERIFIED by ${v.view}: txid ${v.txid} height ${v.height} amount ${v.amountZat} zat memo ${v.memo}`);
  if (v.txid !== sent.txid) throw new Error("verified a different txid than we sent");
  process.exit(0);
} catch (e) {
  console.error(`[${secs()}] NOT VERIFIED: ${(e as Error).message}`);
  process.exit(1);
}
