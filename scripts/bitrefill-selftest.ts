#!/usr/bin/env bun
// bun run bitrefill:selftest [--record]
//  1. LIVE guest-MCP product search (no API key): "jio" + "amazon" in IN, plus Jio package prices
//  2. LIVE NEAR Intents 1Click DRY quote ZEC -> USDC(Base) (no funds, no deposit address)
//  3. If BITREFILL_API_KEY is set: v2 ping + a FREE test-product order (test-gift-card-code, balance, auto_pay)
//     and its redemption code. Otherwise prints "NO KEY — skipping v2" and shows the offline fixture flow.
// --record also writes the raw v2 responses to src/bitrefill/fixtures/v2/ (only when a key is present).
import { mkdirSync } from "fs";
import { join } from "path";
import { createBitrefill, BitrefillV2, McpGuestClient, OfflineBitrefill } from "../src/bitrefill";
import { packagesFromMcpDetails, productFromMcpSearch } from "../src/bitrefill/map";
import { getBridgeQuote } from "../src/bridge";

const record = process.argv.includes("--record");
const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n=== ${s} ${"=".repeat(Math.max(0, 70 - s.length))}`);
let failures = 0;

head("1. Bitrefill hosted MCP — guest token, LIVE search (no API key)");
const mcp = new McpGuestClient();
try {
  for (const [q, intent] of [["jio", "recharge an Indian Jio prepaid number"], ["amazon", "buy an Amazon India gift card"]]) {
    const r = await mcp.callTool<any>("search-products", { query: q, country: "IN", intent });
    const prods = (r.data?.products ?? []).map((p: any) => productFromMcpSearch(p));
    line(`search-products "${q}" country=IN -> ${prods.length} result(s) [mode=${r.mode}, source=${r.source}]`);
    for (const p of prods) line(`  - ${p.id.padEnd(36)} ${p.name} (${p.currency}, in_stock=${p.inStock})`);
  }
  const d = await mcp.callTool<any>("get-product-details", { product_id: "reliance-jio-india-bundles" });
  const pk = packagesFromMcpDetails(d.data);
  const cheap = [...pk].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd)).slice(0, 3);
  line(`get-product-details reliance-jio-india-bundles -> ${pk.length} packages; cheapest:`);
  for (const p of cheap) line(`  - ${String(p.packageId).padEnd(36)} $${p.priceUsd}`);
} catch (e) {
  failures++;
  line(`FAILED: ${(e as Error).message}`);
}

head("2. NEAR Intents 1Click — LIVE dry quote ZEC -> USDC on Base");
try {
  const q = await getBridgeQuote(process.env.ZEC_REFUND_MAINNET_TADDR, undefined, 3, { mode: "dry" });
  line(`mode=${q.mode} kind=${q.kind}: ${q.amountInZec} ZEC (~$${Number(q.amountInUsd ?? 0).toFixed(2)}) -> ${q.amountOutUsdc} USDC on Base, ETA ${q.timeEstimateSec}s`);
  line(`quoteId(correlationId)=${q.quoteId} depositAddress=${q.depositAddress ?? "(none — dry)"}`);
  for (const n of q.notes) line(`  note: ${n}`);
  if (q.fallbackReason) {
    failures++;
    line(`  FALLBACK: ${q.fallbackReason}`);
  }
} catch (e) {
  failures++;
  line(`FAILED: ${(e as Error).message}`);
}

head("3. Bitrefill REST v2 (API key)");
const key = process.env.BITREFILL_API_KEY?.trim();
if (!key) {
  line("NO KEY — skipping v2");
  line("Offline fixture flow instead (mode=fixture, nothing real happened):");
  const o = new OfflineBitrefill();
  const inv = await o.createInvoice([{ productId: "test-gift-card-code", value: 10 }], "balance", { autoPay: true });
  const ord = await o.getOrder(inv.orderIds[0]);
  line(`  invoice ${inv.id} status=${inv.status} [mode=${inv.mode}]`);
  line(`  order   ${ord.id} status=${ord.status} code=${ord.code} [mode=${ord.mode}]`);
} else {
  const b = createBitrefill({ mode: "test", apiKey: key, liveSearch: false });
  const raw = new BitrefillV2({ apiKey: key });
  const dir = join(import.meta.dir, "../src/bitrefill/fixtures/v2");
  const save = async (name: string, data: unknown) => {
    if (!record) return;
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, `${name}.json`), JSON.stringify({ recordedAt: new Date().toISOString(), data }, null, 2) + "\n");
  };
  try {
    const p = await b.ping();
    line(`ping -> ${p.message} [mode=${p.mode}, source=${p.source}]`);
  } catch (e) {
    failures++;
    line(`ping FAILED: ${(e as Error).message}`);
  }
  try {
    const t = await raw.searchProducts("test", { includeTest: true, limit: 50 });
    const tests = (t.data ?? []).filter((p: any) => String(p.id).startsWith("test-") || String(p.id).endsWith("-syldavia"));
    line(`products/search q=test include_test_products=true -> ${t.data?.length ?? 0} results, ${tests.length} test products: ${tests.map((p: any) => p.id).join(", ") || "(none — ask Bitrefill to enable test products?)"}`);
    await save("search-test", t.data);
  } catch (e) {
    line(`test-product search FAILED: ${(e as Error).message}`);
  }
  try {
    const inv = await b.createInvoice([{ productId: "test-gift-card-code", value: 10, quantity: 1 }], "balance", { autoPay: true });
    line(`invoice created ${inv.id} status=${inv.status} raw=${inv.rawStatus} [mode=${inv.mode}]`);
    const done = await b.waitForInvoice(inv.id, { timeoutMs: 45_000, intervalMs: 3_000 });
    line(`invoice ${done.id} -> status=${done.status} raw=${done.rawStatus} payment=${done.paymentStatus} orders=${done.orderIds.join(",")}`);
    await save("invoice-test-gift-card-code", (await raw.getInvoice(inv.id)).data);
    for (const oid of done.orderIds) {
      const ord = await b.getOrder(oid);
      line(`order ${ord.id} status=${ord.status} [mode=${ord.mode}]`);
      line(`  redemption code: ${ord.code ?? "(none)"}${ord.link ? `  link: ${ord.link}` : ""}${ord.instructions ? `  instructions: ${ord.instructions}` : ""}`);
      await save("order-test-gift-card-code", (await raw.getOrder(oid)).data);
    }
  } catch (e) {
    failures++;
    line(`test-product order FAILED: ${(e as Error).message}`);
    const body = (e as any).body;
    if (body) line(`  body: ${JSON.stringify(body).slice(0, 400)}`);
  }
}

line(`\n${failures ? `DONE with ${failures} failure(s)` : "DONE — all live checks passed"}`);
process.exit(failures ? 1 : 0);
