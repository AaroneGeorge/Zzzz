// Bitrefill client factory.
//   BITREFILL_MODE=offline (default) -> fixtures for ping/invoices/orders; product search still goes LIVE to the
//                                       hosted MCP with a guest token (no key) unless BITREFILL_LIVE_SEARCH=0.
//   BITREFILL_MODE=test              -> v2 REST with BITREFILL_API_KEY; ONLY test products may be invoiced.
//   BITREFILL_MODE=real              -> v2 REST; real products may be invoiced, but auto_pay (spending) is refused
//                                       unless BITREFILL_ALLOW_REAL_SPEND=yes.
// test/real without a key degrade to offline (client.mode === "offline", client.degradedReason set).
// Every returned object carries {mode: "real"|"test"|"fixture", source: "v2"|"mcp-guest"|"fixture"}.
import { invoiceFromV2, isTerminalInvoiceStatus, orderFromV2, packagesFromMcpDetails, productFromMcpSearch, productFromV2 } from "./map";
import { McpGuestClient } from "./mcp";
import { fixturePackages, fixtureSearch, OfflineBitrefill } from "./mock";
import {
  BitrefillError,
  isTestProductId,
  type BitrefillClient,
  type BitrefillMode,
  type BrInvoice,
  type BrOrder,
  type BrProduct,
  type CartItem,
  type CreateInvoiceOpts,
  type FetchLike,
  type McpResult,
  type PingResult,
  type SearchOpts,
} from "./types";
import { BitrefillV2 } from "./v2";

export * from "./types";
export { maskCode } from "./map";
export { McpGuestClient } from "./mcp";
export { BitrefillV2 } from "./v2";
export { OfflineBitrefill, TEST_PRODUCTS_FIXTURE } from "./mock";

const DEFAULT_INTENT = "ZecRecharge agent: find a product the user asked for";

export interface CreateBitrefillOpts {
  mode?: BitrefillMode;
  apiKey?: string;
  fetch?: FetchLike;
  /** Live guest-MCP product search when no key / offline. Default: env BITREFILL_LIVE_SEARCH !== "0". */
  liveSearch?: boolean;
  allowRealSpend?: boolean;
}

function envWord(v: string | undefined): string {
  return (v ?? "").split("#")[0].trim().toLowerCase();
}

/** A client with v2 (key) and/or guest MCP, falling back to fixtures with an explicit fallbackReason. */
export class LiveBitrefill implements BitrefillClient {
  readonly hasKey: boolean;
  private v2?: BitrefillV2;
  private mcp: McpGuestClient;
  private offline = new OfflineBitrefill();
  degradedReason?: string;

  constructor(
    readonly mode: BitrefillMode,
    private o: { apiKey?: string; fetch?: FetchLike; liveSearch: boolean; allowRealSpend: boolean },
  ) {
    this.hasKey = !!o.apiKey;
    if (o.apiKey && mode !== "offline") this.v2 = new BitrefillV2({ apiKey: o.apiKey, fetch: o.fetch });
    this.mcp = new McpGuestClient({ fetch: o.fetch });
  }

  async ping(): Promise<PingResult> {
    if (!this.v2) return this.offline.ping();
    const message = await this.v2.ping();
    return { ok: message === "pong", message, mode: this.mode === "test" ? "test" : "real", source: "v2" };
  }

  async searchProducts(q: string, opts: SearchOpts = {}): Promise<BrProduct[]> {
    const includeTest = opts.includeTest ?? this.mode === "test";
    if (this.v2) {
      try {
        const { data } = await this.v2.searchProducts(q, { includeTest, limit: opts.limit });
        let out = (data ?? []).flatMap(productFromV2);
        // v2 search has no country filter; filter client-side but keep test products (they are country KN).
        if (opts.country) out = out.filter((p) => p.isTest || !p.country || p.country.toUpperCase() === opts.country!.toUpperCase());
        return out;
      } catch (e) {
        return this.mcpSearch(q, { ...opts, includeTest }, `v2 search failed: ${(e as Error).message}`);
      }
    }
    return this.mcpSearch(q, { ...opts, includeTest });
  }

  private async mcpSearch(q: string, opts: SearchOpts, prevFail?: string): Promise<BrProduct[]> {
    if (!this.o.liveSearch) return fixtureSearch(q, opts).map((p) => (prevFail ? { ...p, fallbackReason: prevFail } : p));
    try {
      const r = await this.mcp.callTool<any>("search-products", {
        query: q || "*",
        intent: opts.intent ?? DEFAULT_INTENT,
        // MCP country is case-sensitive: "in" or "India" -> "Search service not available". Send alpha-2 upper only.
        ...(opts.country && /^[a-z]{2}$/i.test(opts.country) ? { country: opts.country.toUpperCase() } : {}),
        ...(opts.limit ? { per_page: opts.limit } : {}),
      });
      if (r.isError) throw new BitrefillError(`search-products error: ${r.text.slice(0, 200)}`);
      const live = ((r.data as any)?.products ?? []).map((p: any) => productFromMcpSearch(p));
      // Guest tokens cannot see test products; append the documented ones, honestly labelled "fixture".
      return opts.includeTest ? [...live, ...fixtureSearch("", { includeTest: true }).filter((p) => p.isTest)] : live;
    } catch (e) {
      const reason = [prevFail, `guest MCP search failed: ${(e as Error).message}`].filter(Boolean).join("; ");
      return fixtureSearch(q, opts).map((p) => ({ ...p, fallbackReason: reason }));
    }
  }

  async getProductPackages(productId: string): Promise<BrProduct[]> {
    if (this.v2) {
      try {
        const { data } = await this.v2.getProduct(productId);
        return productFromV2(data);
      } catch (e) {
        if (isTestProductId(productId)) throw e;
      }
    }
    if (!this.o.liveSearch || isTestProductId(productId)) return fixturePackages(productId);
    try {
      const r = await this.mcp.callTool<any>("get-product-details", { product_id: productId });
      if (r.isError) throw new BitrefillError(r.text.slice(0, 200), 404, "product_not_found");
      return packagesFromMcpDetails(r.data);
    } catch (e) {
      return fixturePackages(productId).map((p) => ({ ...p, fallbackReason: `guest MCP details failed: ${(e as Error).message}` }));
    }
  }

  async createInvoice(items: CartItem[], paymentMethod: string, opts: CreateInvoiceOpts = {}): Promise<BrInvoice> {
    if (!this.v2) return this.offline.createInvoice(items, paymentMethod, opts);
    if (!items.length) throw new BitrefillError("no items", 400, "empty_cart");
    if (this.mode === "test") {
      const bad = items.filter((i) => !isTestProductId(i.productId)).map((i) => i.productId);
      if (bad.length) throw new BitrefillError(`BITREFILL_MODE=test refuses non-test products: ${bad.join(", ")}`, 400, "test_mode_guard");
    }
    if (this.mode === "real" && opts.autoPay && !this.o.allowRealSpend && !items.every((i) => isTestProductId(i.productId))) {
      throw new BitrefillError("refusing auto_pay of a real product (set BITREFILL_ALLOW_REAL_SPEND=yes to allow spending)", 400, "spend_guard");
    }
    const { data } = await this.v2.createInvoice({
      products: items.map((i) => ({
        product_id: i.productId,
        quantity: i.quantity ?? 1,
        ...(i.value != null ? { value: i.value } : {}),
        ...(i.packageId != null && i.value == null ? { package_id: i.packageId } : {}),
        ...(i.phoneNumber ? { phone_number: i.phoneNumber } : {}),
      })),
      payment_method: paymentMethod,
      ...(opts.autoPay ? { auto_pay: true } : {}),
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.sendEmail != null ? { send_email: opts.sendEmail } : {}),
    });
    return invoiceFromV2(data);
  }

  async getInvoice(id: string): Promise<BrInvoice> {
    if (!this.v2 || id.startsWith("fixture-")) return this.offline.getInvoice(id);
    return invoiceFromV2((await this.v2.getInvoice(id)).data);
  }

  async getOrder(id: string): Promise<BrOrder> {
    if (!this.v2 || id.startsWith("fixture-")) return this.offline.getOrder(id);
    return orderFromV2((await this.v2.getOrder(id)).data);
  }

  async waitForInvoice(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<BrInvoice> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let inv = await this.getInvoice(id);
    // Stop on a terminal raw status (complete/delivered/failed...). Note: an unpaid crypto invoice waits until timeout.
    while (Date.now() < deadline && !isTerminalInvoiceStatus(inv.rawStatus)) {
      await Bun.sleep(opts.intervalMs ?? 2_000);
      inv = await this.getInvoice(id);
    }
    return inv;
  }

  async mcpCall<T = unknown>(tool: string, args: Record<string, unknown>): Promise<McpResult<T>> {
    if (!this.o.liveSearch) return this.offline.mcpCall<T>(tool, args);
    return this.mcp.callTool<T>(tool, args);
  }
}

export function createBitrefill(opts: CreateBitrefillOpts = {}): BitrefillClient & { degradedReason?: string } {
  const env = process.env;
  const want = (opts.mode ?? envWord(env.BITREFILL_MODE) ?? "offline") as BitrefillMode;
  const mode: BitrefillMode = want === "test" || want === "real" ? want : "offline";
  const apiKey = opts.apiKey ?? (env.BITREFILL_API_KEY?.trim() || undefined);
  const liveSearch = opts.liveSearch ?? envWord(env.BITREFILL_LIVE_SEARCH) !== "0";
  const allowRealSpend = opts.allowRealSpend ?? envWord(env.BITREFILL_ALLOW_REAL_SPEND) === "yes";
  if (mode !== "offline" && !apiKey) {
    const c = new LiveBitrefill("offline", { fetch: opts.fetch, liveSearch, allowRealSpend: false });
    c.degradedReason = `BITREFILL_MODE=${mode} but BITREFILL_API_KEY is empty — running offline (fixtures + guest MCP search)`;
    return c;
  }
  return new LiveBitrefill(mode, { apiKey, fetch: opts.fetch, liveSearch, allowRealSpend });
}
