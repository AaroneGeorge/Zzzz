#!/usr/bin/env bun
// Re-record the fixtures used by src/bitrefill/mock.ts and src/bridge/mock.ts from REAL live calls
// (guest MCP — no API key — and a NEAR Intents 1Click dry quote — no funds).
// Usage: bun run scripts/bitrefill-record-fixtures.ts
import { mkdirSync } from "fs";
import { join } from "path";
import { McpGuestClient } from "../src/bitrefill/mcp";
import { requestDryQuote, PLACEHOLDER_REFUND_T_ADDR, BITREFILL_X402_PAYTO_BASE } from "../src/bridge/oneclick";

const root = join(import.meta.dir, "..");
const mcpDir = join(root, "src/bitrefill/fixtures/mcp");
const bridgeDir = join(root, "src/bridge/fixtures");
mkdirSync(mcpDir, { recursive: true });
mkdirSync(bridgeDir, { recursive: true });

const calls: Array<{ name: string; tool: string; args: Record<string, unknown> }> = [
  { name: "search-jio-IN", tool: "search-products", args: { query: "jio", country: "IN", intent: "recharge an Indian Jio prepaid number" } },
  { name: "search-amazon-IN", tool: "search-products", args: { query: "amazon", country: "IN", intent: "buy an Amazon India gift card" } },
  { name: "search-amazon-india-IN", tool: "search-products", args: { query: "amazon india", country: "IN", intent: "buy an Amazon India gift card" } },
  { name: "details-reliance-jio-india-bundles", tool: "get-product-details", args: { product_id: "reliance-jio-india-bundles" } },
  { name: "details-amazon-shopping-vouchers-india", tool: "get-product-details", args: { product_id: "amazon-shopping-vouchers-india" } },
  { name: "details-test-gift-card-code", tool: "get-product-details", args: { product_id: "test-gift-card-code" } },
];

const mcp = new McpGuestClient();
for (const c of calls) {
  const r = await mcp.callTool(c.tool, c.args);
  await Bun.write(
    join(mcpDir, `${c.name}.json`),
    JSON.stringify({ recordedAt: new Date().toISOString(), source: "bitrefill hosted MCP, guest client_credentials token", tool: c.tool, args: c.args, isError: r.isError, text: r.text }, null, 2) + "\n",
  );
  console.log(`recorded ${c.name} (${r.text.length} chars${r.isError ? ", isError" : ""})`);
}

const q = await requestDryQuote({ refundTo: PLACEHOLDER_REFUND_T_ADDR, recipient: BITREFILL_X402_PAYTO_BASE, usdAmount: 3 });
await Bun.write(join(bridgeDir, "dry-quote-zec-usdc-base-3usd.json"), JSON.stringify({ recordedAt: new Date().toISOString(), source: "POST https://1click.chaindefuser.com/v0/quote (dry:true)", response: q }, null, 2) + "\n");
console.log(`recorded 1Click dry quote: ${q.quote.amountInFormatted} ZEC -> ${q.quote.amountOutFormatted} USDC`);
