// Track-2 local types. The shared contract lives in src/types.ts (frozen); everything
// here only *extends* those types so callers can keep using Product/Invoice/Order.
import type { Invoice, Order, Product } from "../types";

/** Which backend the client talks to (env BITREFILL_MODE). */
export type BitrefillMode = "test" | "real" | "offline";

/**
 * Honesty label carried by every returned object.
 *  - "real":    live data from Bitrefill production (catalog listing, or a real invoice/order)
 *  - "test":    live call to Bitrefill, but a free test product (no money moved)
 *  - "fixture": recorded/synthesised data, no network call happened
 */
export type DataMode = "real" | "test" | "fixture";

/** Where the data came from. */
export type DataSource = "v2" | "mcp-guest" | "fixture";

export interface Tag {
  mode: DataMode;
  source: DataSource;
  /** Set when a live call failed and we degraded to fixtures. */
  fallbackReason?: string;
}

export type BrProduct = Product & Tag & {
  inStock?: boolean;
  url?: string;
  /** e.g. "phone_number" for refills (needs phoneNumber in the cart item). */
  recipientType?: string;
  /** Price Bitrefill quotes for this package, in USD (from get-product-details). */
  priceUsd?: string;
  type?: string;
};

export type BrInvoice = Invoice & Tag & {
  /** Bitrefill's own status string, untouched (Invoice.status is our normalised view). */
  rawStatus: string;
  paymentStatus?: string;
  priceUsd?: string;
  createdAt?: string;
  products: Array<{ productId: string; value?: string; packageId?: string; quantity: number }>;
};

export type BrOrder = Order & Tag & { productId?: string; invoiceId?: string; deliveredAt?: string };

export interface CartItem {
  productId: string;
  /** v2 `package_id` (e.g. "amazon-us<&>50"); MCP calls this package_value. */
  packageId?: string;
  /** v2 `value` for ranged products / test products (e.g. 10). */
  value?: number;
  quantity?: number;
  phoneNumber?: string;
}

export interface CreateInvoiceOpts {
  /** Only valid with payment_method=balance. Refused in `real` mode unless BITREFILL_ALLOW_REAL_SPEND=yes. */
  autoPay?: boolean;
  email?: string;
  sendEmail?: boolean;
}

export interface SearchOpts {
  /** ISO alpha-2, e.g. "IN". */
  country?: string;
  includeTest?: boolean;
  limit?: number;
  /** MCP requires a free-text intent; defaulted if omitted. */
  intent?: string;
}

export interface McpResult<T = unknown> extends Tag {
  tool: string;
  /** Decoded payload (Bitrefill MCP returns TOON text; we decode it to JS). */
  data: T;
  /** Original text content as returned by the server. */
  text: string;
  isError: boolean;
}

export interface PingResult extends Tag {
  ok: boolean;
  message: string;
}

export interface BitrefillClient {
  readonly mode: BitrefillMode;
  readonly hasKey: boolean;
  ping(): Promise<PingResult>;
  searchProducts(q: string, opts?: SearchOpts): Promise<BrProduct[]>;
  /** One BrProduct per package (packageId = package_value as Bitrefill names it). */
  getProductPackages(productId: string): Promise<BrProduct[]>;
  createInvoice(items: CartItem[], paymentMethod: string, opts?: CreateInvoiceOpts): Promise<BrInvoice>;
  getInvoice(id: string): Promise<BrInvoice>;
  getOrder(id: string): Promise<BrOrder>;
  /** Poll getInvoice until it leaves unpaid/paid or timeout. */
  waitForInvoice(id: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<BrInvoice>;
  /** Raw hosted-MCP tool call with a guest client_credentials token (no API key). */
  mcpCall<T = unknown>(tool: string, args: Record<string, unknown>): Promise<McpResult<T>>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class BitrefillError extends Error {
  constructor(message: string, public status?: number, public code?: string, public body?: unknown) {
    super(message);
    this.name = "BitrefillError";
  }
}

export const TEST_PRODUCT_IDS = [
  "test-gift-card-code",
  "test-gift-card-link",
  "test-phone-refill",
  "test-gift-card-code-fail",
  "test-gift-card-link-fail",
  "test-phone-refill-fail",
] as const;

export function isTestProductId(id: string): boolean {
  return id.startsWith("test-") || id.endsWith("-syldavia");
}
