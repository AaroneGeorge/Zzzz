// Pure mappers: raw Bitrefill payloads (v2 REST JSON or decoded MCP TOON) -> shared types + honesty tag.
import type { Invoice } from "../types";
import { isTestProductId, type BrInvoice, type BrOrder, type BrProduct, type DataSource, type Tag } from "./types";

function productTag(id: string, source: DataSource): Tag {
  if (source === "fixture") return { mode: "fixture", source };
  return { mode: isTestProductId(id) ? "test" : "real", source };
}

/** Leading number of a package label: "₹39.37 Talktime Top-Up" -> 39.37, "30" -> 30, "30GB – 30 Day" -> undefined. */
export function numericValue(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^[^\d]{0,2}(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!m) return /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined;
  return Number(m[1]);
}

/** Item of MCP `search-products` (decoded TOON). */
export function productFromMcpSearch(p: any, source: DataSource = "mcp-guest"): BrProduct {
  const id = String(p.slug ?? p._id ?? p.id);
  return {
    id,
    name: String(p.name ?? id),
    currency: String(p.currency ?? "USD"),
    country: Array.isArray(p.countries) ? p.countries[0] : p.country_code,
    isTest: isTestProductId(id),
    inStock: p.in_stock,
    url: p.product_url,
    type: p.type,
    ...productTag(id, source),
  };
}

/** MCP `get-product-details` -> one BrProduct per package. */
export function packagesFromMcpDetails(d: any, source: DataSource = "mcp-guest"): BrProduct[] {
  const id = String(d.id ?? d.slug);
  const base = {
    id,
    name: String(d.name ?? id),
    currency: String(d.currency ?? "USD"),
    country: d.country_code,
    isTest: isTestProductId(id),
    inStock: d.in_stock,
    url: d.url,
    recipientType: d.recipient_type,
    ...productTag(id, source),
  };
  const pkgs: any[] = Array.isArray(d.packages) ? d.packages : [];
  if (!pkgs.length) return [base];
  return pkgs.map((p) => ({
    ...base,
    packageId: String(p.package_value),
    value: numericValue(p.package_value),
    priceUsd: p.payment_currency === "USD" ? String(p.payment_price) : undefined,
  }));
}

/** v2 `/products/search` item (docs schema: packages[] {id,value,price}, range {min,max,step}). */
export function productFromV2(p: any): BrProduct[] {
  const id = String(p.id);
  const base = {
    id,
    name: String(p.name ?? id),
    currency: String(p.currency ?? "USD"),
    country: p.country_code,
    isTest: isTestProductId(id),
    inStock: p.in_stock,
    recipientType: p.recipient_type,
    ...productTag(id, "v2"),
  };
  // The OpenAPI page types `packages` as an object; real responses are believed to be arrays. Accept both.
  const pkgs: any[] = Array.isArray(p.packages) ? p.packages : p.packages ? [p.packages] : [];
  if (!pkgs.length) return [{ ...base, value: p.range?.min }];
  return pkgs.map((k) => ({ ...base, packageId: k.id != null ? String(k.id) : undefined, value: numericValue(k.value) }));
}

const DONE = ["complete", "completed", "all_delivered", "delivered", "success"];
const PAID = ["paid", "payment_received", "payment_confirmed", "payment_detected", "processing", "not_delivered", "partial_delivery"];
const FAILED = ["failed", "denied", "payment_error", "expired", "refunded", "cancelled", "canceled", "error"];

export function isTerminalInvoiceStatus(raw: string): boolean {
  const s = (raw ?? "").toLowerCase();
  return DONE.includes(s) || FAILED.includes(s);
}

export function normaliseInvoiceStatus(raw: string, paymentStatus: string | undefined, testOnly: boolean, method: string): Invoice["status"] {
  const s = (raw ?? "").toLowerCase();
  const ps = (paymentStatus ?? "").toLowerCase();
  let st: Invoice["status"] = "unpaid";
  if (FAILED.includes(s) || FAILED.includes(ps)) st = "failed";
  else if (DONE.includes(s)) st = "complete";
  else if (PAID.includes(s) || PAID.includes(ps)) st = "paid";
  if (testOnly && method === "balance" && (st === "paid" || st === "complete")) return "test_autopaid";
  return st;
}

/** v2 invoice (`data` of POST /invoices or GET /invoices/{id}). */
export function invoiceFromV2(d: any, source: DataSource = "v2"): BrInvoice {
  const orders: any[] = Array.isArray(d.orders) ? d.orders : [];
  const products = orders.map((o) => ({
    productId: String(o.product?.id ?? ""),
    value: o.product?.value != null ? String(o.product.value) : undefined,
    quantity: 1,
  }));
  const testOnly = products.length > 0 && products.every((p) => isTestProductId(p.productId));
  const method = String(d.payment?.method ?? "unknown");
  const rawStatus = String(d.status ?? "unknown");
  const mode = source === "fixture" ? "fixture" : testOnly ? "test" : "real";
  const addr = d.payment?.address ?? d.payment?.lightning_invoice ?? d.payment?.payment_uri;
  return {
    id: String(d.id),
    status: normaliseInvoiceStatus(rawStatus, d.payment?.status, testOnly, method),
    rawStatus,
    paymentStatus: d.payment?.status,
    paymentMethod: method,
    payTo:
      addr && method !== "balance"
        ? { address: String(addr), amount: String(d.payment?.price ?? d.payment?.amount ?? ""), currency: String(d.payment?.currency ?? "") }
        : undefined,
    priceUsd: d.payment?.currency === "USD" && d.payment?.price != null ? String(d.payment.price) : undefined,
    orderIds: orders.map((o) => String(o.id)),
    expiresAt: d.expiration_time ?? d.expires_time ?? d.payment?.expiration_time,
    createdAt: d.created_time,
    products,
    mode,
    source,
  };
}

/** v2 order. `redemption_info` is documented as a string but described elsewhere as {code, link, instructions}. */
export function orderFromV2(d: any, source: DataSource = "v2"): BrOrder {
  const ri = d.redemption_info;
  let code: string | undefined, link: string | undefined, instructions: string | undefined;
  if (typeof ri === "string") instructions = ri;
  else if (ri && typeof ri === "object") {
    code = ri.code ?? ri.pin ?? ri.voucher ?? undefined;
    link = ri.link ?? ri.url ?? undefined;
    instructions = ri.instructions ?? ri.other ?? undefined;
  }
  const productId = d.product?.id ? String(d.product.id) : undefined;
  const mode = source === "fixture" ? "fixture" : productId && isTestProductId(productId) ? "test" : "real";
  return {
    id: String(d.id),
    status: String(d.status ?? "unknown"),
    code: code != null ? String(code) : undefined,
    link,
    instructions,
    productId,
    invoiceId: d.invoice?.id,
    deliveredAt: d.delivered_time,
    mode,
    source,
  };
}

/** Mask a redemption code for display: keep last 4. */
export function maskCode(code?: string): string | undefined {
  if (!code) return code;
  return code.length <= 4 ? "****" : "*".repeat(Math.min(code.length - 4, 12)) + code.slice(-4);
}
