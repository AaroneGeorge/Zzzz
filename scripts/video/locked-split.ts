// Run scripts/wallet-split.ts while holding the agent wallet's cross-process lock
// (wallet-split itself bypasses the lock). Usage: bun run scripts/video/locked-split.ts [N] [ZAT]
import { join } from "node:path";
import { acquireLock } from "../../src/wallet/zingo";
const dir = join(import.meta.dir, "..", "..", ".secrets", "zingo-testnet");
console.log(new Date().toISOString(), "waiting for wallet lock…");
const release = await acquireLock(dir);
console.log(new Date().toISOString(), "lock held; splitting");
try {
  const p = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "wallet-split.ts"), ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = await p.exited;
} finally {
  release();
  console.log(new Date().toISOString(), "lock released");
}
