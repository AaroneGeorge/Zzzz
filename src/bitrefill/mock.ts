// Offline Bitrefill client. Every object it returns carries mode:"fixture", source:"fixture".
//  - Catalog data (search / product details) = REAL responses recorded from the hosted MCP with a guest
//    token (fixtures/mcp/*.json, re-record with `bun run scripts/bitrefill-record-fixtures.ts`).
//  - v2 invoice/order shapes = SYNTHESISED from the docs.bitrefill.com OpenAPI examples (we had no API key
//    when this was written). They are never marked paid unless the item is a free test product.
import { decodeToolText } from "./mcp";
import { invoiceFromV2, orderFromV2, packagesFromMcpDetails, productFromMcpSearch } from "./map";
import {
  BitrefillError,
  isTestProductId,
  type BitrefillClient,
  type BrInvoice,
  type BrOrder,
  type BrProduct,
  type CartItem,
  type CreateInvoiceOpts,
  type McpResult,
  type PingResult,
  type SearchOpts,
} from "./types";

import searchJio from "./fixtures/mcp/search-jio-IN.json";
import searchAmazon from "./fixtures/mcp/search-amazon-IN.json";
import searchAmazonIndia from "./fixtures/mcp/search-amazon-india-IN.json";
import detailsJio from "./fixtures/mcp/details-reliance-jio-india-bundles.json";
import detailsAmazon from "./fixtures/mcp/details-amazon-shopping-vouchers-india.json";
import detailsTestCode from "./fixtures/mcp/details-test-gift-card-code.json";

type Rec = { recordedAt: string; tool: string; args: Record<string, unknown>; isError: boolean; text: string };
export const MCP_RECORDINGS: Rec[] = [searchJio, searchAmazon, searchAmazonIndia, detailsJio, detailsAmazon, detailsTestCode];

/** Placeholder payment address for fixture crypto invoices (Bitrefill's public x402 Base pay-to). Never pay it. */
const FIXTURE_PAY_ADDR = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";

/** Test products per docs.bitrefill.com/docs/test-products (USD, KN). Synthesised: guest MCP cannot see them. */
export const TEST_PRODUCTS_FIXTURE: BrProduct[] = [
  { id: "test-gift-card-code", name: "Test Gift Card Code", currency: "USD", country: "KN", isTest: true, value: 10, packageId: "test-gift-card-code<&>10", mode: "fixture", source: "fixture", inStock: true, recipientType: "none" },
  { id: "test-gift-card-link", name: "Test Gift Card Link", currency: "USD", country: "KN", isTest: true, value: 10, packageId: "test-gift-card-link<&>10", mode: "fixture", source: "fixture", inStock: true, recipientType: "none" },
  { id: "test-phone-refill", name: "Test Phone Refill", currency: "USD", country: "KN", isTest: true, value: 10, packageId: "test-phone-refill<&>10", mode: "fixture", source: "fixture", inStock: true, recipientType: "phone_number" },
];

function recordedProducts(rec: Rec): BrProduct[] {
  const d: any = decodeToolText(rec.text);
  return (d?.products ?? []).map((p: any) => productFromMcpSearch(p, "fixture"));
}

export function fixtureSearch(q: string, opts: SearchOpts = {}): BrProduct[] {
  const ql = q.toLowerCase().trim();
  let out: BrProduct[];
  if (ql.includes("jio")) out = recordedProducts(searchJio);
  else if (ql.includes("amazon") && ql.includes("india")) out = recordedProducts(searchAmazonIndia);
  else if (ql.includes("amazon")) out = recordedProducts(searchAmazon);
  else {
    const all = [searchJio, searchAmazon].flatMap(recordedProducts);
    const seen = new Set<string>();
    out = all.filter((p) => !seen.has(p.id) && seen.add(p.id) && (ql === "*" || ql === "" || p.name.toLowerCase().includes(ql)));
  }
  if (opts.country) out = out.filter((p) => !p.country || p.country.toUpperCase() === opts.country!.toUpperCase());
  // Test products are always appended when asked for: the demo buys one regardless of the brand searched.
  if (opts.includeTest) out = [...out, ...TEST_PRODUCTS_FIXTURE];
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export function fixturePackages(productId: string): BrProduct[] {
  if (isTestProductId(productId)) {
    const t = TEST_PRODUCTS_FIXTURE.find((p) => p.id === productId);
    if (!t) throw new BitrefillError(`fixture: unknown test product ${productId}`, 404, "product_not_found");
    return [10, 25, 50].map((v) => ({ ...t, value: v, packageId: `${productId}<&>${v}`, priceUsd: String(v) }));
  }
  const rec = [detailsJio, detailsAmazon].find((r) => r.args.product_id === productId);
  if (!rec) throw new BitrefillError(`fixture: no recorded details for ${productId}`, 404, "product_not_found");
  return packagesFromMcpDetails(decodeToolText(rec.text), "fixture");
}

/** In-memory offline backend. Shape mirrors the docs' v2 Invoice/Order schema so mappers are exercised. */
export class OfflineBitrefill implements BitrefillClient {
  readonly mode = "offline" as const;
  readonly hasKey = false;
  private invoices = new Map<string, any>();
  private orders = new Map<string, any>();
  private seq = 0;

  async ping(): Promise<PingResult> {
    return { ok: true, message: "pong (fixture — no network call)", mode: "fixture", source: "fixture" };
  }

  async searchProducts(q: string, opts: SearchOpts = {}): Promise<BrProduct[]> {
    return fixtureSearch(q, opts);
  }

  async getProductPackages(productId: string): Promise<BrProduct[]> {
    return fixturePackages(productId);
  }

  async createInvoice(items: CartItem[], paymentMethod: string, opts: CreateInvoiceOpts = {}): Promise<BrInvoice> {
    if (!items.length) throw new BitrefillError("no items", 400, "empty_cart");
    if (opts.autoPay && paymentMethod !== "balance") throw new BitrefillError("auto_pay is only valid with payment_method=balance", 400, "invalid_auto_pay");
    const n = ++this.seq;
    const id = `fixture-inv-${Date.now().toString(36)}-${n}`;
    const testOnly = items.every((i) => isTestProductId(i.productId));
    const autopaid = testOnly && paymentMethod === "balance" && !!opts.autoPay;
    const now = new Date().toISOString();
    let priceUsd = 0;
    const orders = items.map((it, k) => {
      const value = it.value ?? (it.packageId ? Number(String(it.packageId).split("<&>")[1]) || undefined : undefined);
      let pkgPrice: number | undefined;
      try {
        const pk = fixturePackages(it.productId).find((p) => p.packageId === it.packageId || (value != null && p.value === value));
        pkgPrice = pk?.priceUsd ? Number(pk.priceUsd) : undefined;
      } catch {}
      priceUsd += (pkgPrice ?? value ?? 0) * (it.quantity ?? 1);
      const oid = `fixture-ord-${Date.now().toString(36)}-${n}-${k}`;
      const order = {
        id: oid,
        status: autopaid ? (it.productId.endsWith("-fail") ? "failed" : "delivered") : "created",
        product: { id: it.productId, name: it.productId, value: value != null ? String(value) : it.packageId, currency: isTestProductId(it.productId) ? "USD" : "INR" },
        created_time: now,
        delivered_time: autopaid ? now : undefined,
        invoice: { id, _href: `/invoices/${id}` },
        redemption_info:
          autopaid && !it.productId.endsWith("-fail")
            ? it.productId.includes("link")
              ? { link: `https://www.bitrefill.com/fixture/test-link/${oid}`, instructions: "FIXTURE test gift card link" }
              : it.productId.includes("refill")
                ? { instructions: `FIXTURE: test refill of ${value ?? "?"} USD to ${it.phoneNumber ?? "(no number)"}` }
                : { code: `FIXTURE-TEST-${oid.slice(-6).toUpperCase()}`, instructions: "FIXTURE test gift card code (not redeemable)" }
            : undefined,
      };
      this.orders.set(oid, order);
      return order;
    });
    const raw = {
      id,
      created_time: now,
      status: autopaid ? (orders.some((o) => o.status === "failed") ? "failed" : "complete") : "unpaid",
      payment: {
        method: paymentMethod,
        address: paymentMethod === "balance" ? undefined : FIXTURE_PAY_ADDR,
        currency: "USD",
        price: Number(priceUsd.toFixed(2)),
        status: autopaid ? "paid" : "unpaid",
      },
      expiration_time: autopaid ? undefined : new Date(Date.now() + 15 * 60_000).toISOString(),
      orders,
    };
    this.invoices.set(id, raw);
    return invoiceFromV2(raw, "fixture");
  }

  async getInvoice(id: string): Promise<BrInvoice> {
    const raw = this.invoices.get(id);
    if (!raw) throw new BitrefillError(`fixture invoice ${id} not found`, 404, "not_found");
    return invoiceFromV2(raw, "fixture");
  }

  async getOrder(id: string): Promise<BrOrder> {
    const raw = this.orders.get(id);
    if (!raw) throw new BitrefillError(`fixture order ${id} not found`, 404, "not_found");
    return orderFromV2(raw, "fixture");
  }

  async waitForInvoice(id: string): Promise<BrInvoice> {
    return this.getInvoice(id);
  }

  async mcpCall<T = unknown>(tool: string, args: Record<string, unknown>): Promise<McpResult<T>> {
    const key = JSON.stringify(args);
    const rec =
      MCP_RECORDINGS.find((r) => r.tool === tool && JSON.stringify(r.args) === key) ??
      MCP_RECORDINGS.find((r) => r.tool === tool && (r.args.product_id === args.product_id && args.product_id != null || r.args.query === args.query && args.query != null));
    if (!rec) throw new BitrefillError(`no MCP fixture for ${tool} ${key}`, 404, "no_fixture");
    return { tool, data: decodeToolText(rec.text) as T, text: rec.text, isError: rec.isError, mode: "fixture", source: "fixture" };
  }
}
