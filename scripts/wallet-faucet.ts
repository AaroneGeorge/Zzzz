// Claim testnet ZEC (TAZ) for our wallet address.
// 1) https://fauzec.com  — POST /api/v1/claim {address, network:"testnet"}; worked on 2026-11-04 (1 TAZ,
//    no captcha when called directly; the web form shows a Cloudflare Turnstile). Probably 1 claim/address/day.
// 2) https://zcashfaucet.jinolabs.xyz — proof-of-work "human check" instead of a CAPTCHA:
//    find nonce so sha256("<seed>:<nonce>") has >= difficulty leading zero bits. Its node was down on 2026-11-04 (503).
// Usage: bun run scripts/wallet-faucet.ts <utest1...|tm...>
import { createHash } from "node:crypto";

const BASE = "https://zcashfaucet.jinolabs.xyz";
const address = process.argv[2];
if (!address) {
  console.error("usage: bun run scripts/wallet-faucet.ts <testnet address>");
  process.exit(2);
}

function leadingZeroBits(d: Uint8Array): number {
  let bits = 0;
  for (const x of d) {
    if (x === 0) { bits += 8; continue; }
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      if (x & mask) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

{
  const res = await fetch("https://fauzec.com/api/v1/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, network: "testnet" }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  console.log(`fauzec.com POST /api/v1/claim -> HTTP ${res.status}`, JSON.stringify(body));
  if (res.ok && body.outcome === "accepted" && body.txid) process.exit(0);
  console.log("fauzec did not pay out; trying zcashfaucet.jinolabs.xyz");
}

const status = await (await fetch(`${BASE}/api/status`)).json() as Record<string, unknown>;
console.log("faucet status:", JSON.stringify({ network: status.network, dripTaz: status.dripTaz, challenge: status.challenge, empty: status.empty, backend: (status.backend as any)?.endpoint }));

const ch = await (await fetch(`${BASE}/api/pow/challenge`)).json() as { ok: boolean; seed: string; difficulty: number; exp: number; sig: string };
if (!ch.ok) throw new Error("no challenge: " + JSON.stringify(ch));
const t0 = Date.now();
let nonce = 0;
for (;;) {
  const h = createHash("sha256").update(`${ch.seed}:${nonce}`).digest();
  if (leadingZeroBits(h) >= ch.difficulty) break;
  nonce++;
}
console.log(`pow solved: difficulty=${ch.difficulty} nonce=${nonce} in ${Date.now() - t0} ms`);

for (let attempt = 0; attempt < 3; attempt++) {
  const res = await fetch(`${BASE}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, network: "taz", pow: { seed: ch.seed, difficulty: ch.difficulty, exp: ch.exp, sig: ch.sig, nonce: String(nonce) } }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  console.log(`POST /api/faucet -> HTTP ${res.status}`, JSON.stringify(body));
  const retry = Number(body.retryAfterSeconds);
  if (res.status === 503 && Number.isFinite(retry) && retry > 0 && retry <= 10 && !body.kind) {
    await Bun.sleep(retry * 1000);
    continue;
  }
  process.exit(res.ok && body.ok ? 0 : 1);
}
process.exit(1);
