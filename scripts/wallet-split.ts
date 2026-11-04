// Pre-demo helper: split a zingo wallet into several spendable notes (ONE self-send tx with N outputs),
// so back-to-back demo runs don't wait for change to reach 3 confirmations.
//   bun run scripts/wallet-split.ts [N=6] [ZAT_EACH=5000000]          # agent wallet (.secrets/zingo-testnet)
// Testnet only. Wait ~3 blocks (3-5 min) after it prints the txid before the first demo run.
import { join } from "node:path";
import { bunReplSpawner, isSynced, ZingoSession } from "../src/wallet/zingo";
import { explorerUrl } from "../src/wallet/util";

const N = Number(process.argv[2] ?? 6);
const EACH = Number(process.argv[3] ?? 5_000_000);
const cmd = [join(import.meta.dir, "wallet-zingo.sh")];
const s = new ZingoSession(cmd, bunReplSpawner);
try {
  for (let i = 0; ; i++) {
    const st = await s.cmd<any>("sync status", 60_000);
    if (isSynced(st)) break;
    if (i > 200) throw new Error("sync timeout");
    await Bun.sleep(3000);
  }
  const addrs = await s.cmd<Array<{ encoded_address: string }>>("addresses", 60_000);
  const me = addrs[0]!.encoded_address;
  const bal = await s.cmd<{ spendable_balance: number }>("spendable_balance", 60_000);
  console.log(`spendable before: ${bal.spendable_balance} zat`);
  const items = Array.from({ length: N }, (_, i) => ({ address: me, amount: EACH, memo: `ZR-split ${i + 1}/${N}` }));
  const prop = await s.cmd<any>(`send '${JSON.stringify(items)}'`, 120_000);
  console.log("proposal:", JSON.stringify(prop).slice(0, 300));
  const r = await s.cmd<{ txids?: string[] }>("confirm", 300_000);
  const txid = r.txids?.[0];
  console.log(`split txid: ${txid}\n${txid ? explorerUrl(txid, "testnet") : JSON.stringify(r).slice(0, 400)}`);
} finally {
  await s.close();
}
