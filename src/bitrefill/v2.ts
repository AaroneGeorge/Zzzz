// Bitrefill REST v2 (https://api.bitrefill.com/v2), `Authorization: Bearer <BITREFILL_API_KEY>`.
// Thin wrapper: returns the raw `data` payloads; mapping/honesty tags happen in index.ts.
import { BitrefillError, type FetchLike } from "./types";

export const V2_BASE = "https://api.bitrefill.com/v2";
const PING_MIN_INTERVAL_MS = 3_100; // docs: /ping is rate limited to 1 req / 3 s

export interface V2Opts {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export class BitrefillV2 {
  private f: FetchLike;
  private base: string;
  private key: string;
  private timeoutMs: number;
  private lastPing = 0;

  constructor(opts: V2Opts) {
    if (!opts.apiKey) throw new BitrefillError("BITREFILL_API_KEY missing");
    this.key = opts.apiKey;
    this.f = opts.fetch ?? fetch;
    this.base = opts.baseUrl ?? V2_BASE;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async req<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ data: T; meta?: any; headers: Headers }> {
    const r = await this.f(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    let j: any;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { message: text.slice(0, 300) };
    }
    if (!r.ok) {
      throw new BitrefillError(
        `Bitrefill v2 ${method} ${path} -> ${r.status}: ${j.message ?? j.error ?? "error"}`,
        r.status,
        j.error_code ?? j.status,
        j,
      );
    }
    return { data: j.data ?? j, meta: j.meta, headers: r.headers };
  }

  async ping(): Promise<string> {
    const wait = this.lastPing + PING_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.lastPing = Date.now();
    const { data } = await this.req<any>("GET", "/ping");
    return String(data?.message ?? data);
  }

  async searchProducts(q: string, opts: { includeTest?: boolean; limit?: number; start?: number } = {}) {
    const p = new URLSearchParams({ q: q || "*" });
    if (opts.includeTest) p.set("include_test_products", "true");
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.start) p.set("start", String(opts.start));
    return this.req<any[]>("GET", `/products/search?${p}`);
  }

  async listProducts(opts: { includeTest?: boolean; limit?: number; start?: number } = {}) {
    const p = new URLSearchParams();
    if (opts.includeTest) p.set("include_test_products", "true");
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.start) p.set("start", String(opts.start));
    return this.req<any[]>("GET", `/products?${p}`);
  }

  async getProduct(id: string) {
    return this.req<any>("GET", `/products/${encodeURIComponent(id)}`);
  }

  async createInvoice(body: {
    products: Array<{ product_id: string; quantity: number; value?: number; package_id?: string; phone_number?: string }>;
    payment_method: string;
    auto_pay?: boolean;
    email?: string;
    send_email?: boolean;
  }) {
    return this.req<any>("POST", "/invoices", body);
  }

  async getInvoice(id: string) {
    return this.req<any>("GET", `/invoices/${encodeURIComponent(id)}`);
  }

  async payInvoice(id: string) {
    return this.req<any>("POST", `/invoices/${encodeURIComponent(id)}/pay`);
  }

  async getOrder(id: string) {
    return this.req<any>("GET", `/orders/${encodeURIComponent(id)}`);
  }

  async balance() {
    return this.req<any>("GET", "/accounts/balance");
  }
}
