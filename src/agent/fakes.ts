// In-folder fakes used until (or instead of) the real T1/T2 modules. Every object they return
// is labelled mode "mock" (wallet) or "fixture" (Bitrefill, bridge) so nothing passes as real.
import { createHash } from "node:crypto";
import type { BridgeQuote, Invoice, Order, Product, ShieldedSend } from "../types";
import type { BitrefillLike, InvoiceItem, WalletLike } from "./deps";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const FAKE_PRODUCTS: Array<Product & { category: string; mode: "fixture" }> = [
  { id: "jio-india", name: "Jio India (prepaid recharge)", currency: "INR", country: "IN", isTest: false, category: "mobile_topup", mode: "fixture" },
  { id: "airtel-india", name: "Airtel India (prepaid recharge)", currency: "INR", country: "IN", isTest: false, category: "mobile_topup", mode: "fixture" },
  { id: "vi-india", name: "Vi (Vodafone Idea) India", currency: "INR", country: "IN", isTest: false, category: "mobile_topup", mode: "fixture" },
  { id: "amazon_pay-india", name: "Amazon Pay India gift card", currency: "INR", country: "IN", isTest: false, category: "gift_card", mode: "fixture" },
  { id: "flipkart-india", name: "Flipkart gift card", currency: "INR", country: "IN", isTest: false, category: "gift_card", mode: "fixture" },
  { id: "swiggy-india", name: "Swiggy gift card", currency: "INR", country: "IN", isTest: false, category: "gift_card", mode: "fixture" },
  { id: "test-phone-refill", name: "Bitrefill test phone refill", currency: "USD", isTest: true, value: 10, packageId: "test-phone-refill<&>10", category: "mobile_topup", mode: "fixture" },
  { id: "test-gift-card-code", name: "Bitrefill test gift card (code)", currency: "USD", isTest: true, value: 10, packageId: "test-gift-card-code<&>10", category: "gift_card", mode: "fixture" },
];

export function createFakeBitrefill(opts: { delayMs?: number } = {}): BitrefillLike & { invoices: Map<string, Invoice> } {
  const invoices = new Map<string, Invoice>();
  const orders = new Map<string, Order>();
  const wait = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
  let n = 0;
  return {
    invoices,
    async ping() {
      await wait();
      return { message: "pong", mode: "fixture" };
    },
    async searchProducts(q, { includeTest }) {
      await wait();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return FAKE_PRODUCTS.filter((p) => (includeTest || !p.isTest) && words.some((w) => p.name.toLowerCase().includes(w) || p.id.includes(w))).map(
        (p) => ({ ...p }),
      );
    },
    async createInvoice(items: InvoiceItem[], paymentMethod: string) {
      await wait();
      n += 1;
      const id = `fx-inv-${sha(JSON.stringify(items) + n + Date.now()).slice(0, 12)}`;
      const orderId = `fx-ord-${id.slice(7)}`;
      const isTest = items.every((i) => i.productId.startsWith("test-"));
      const inv: Invoice & { mode: string } = {
        id,
        status: isTest ? "test_autopaid" : "unpaid",
        paymentMethod,
        payTo: isTest ? undefined : { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "2.85", currency: "USDC" },
        orderIds: [orderId],
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        mode: "fixture",
      };
      invoices.set(id, inv);
      orders.set(orderId, {
        id: orderId,
        status: isTest ? "delivered" : "awaiting_payment",
        code: isTest ? `FIXTURE-${sha(orderId).slice(0, 4).toUpperCase()}-${sha(id).slice(0, 4).toUpperCase()}` : undefined,
        instructions: isTest ? "Fixture order: no real value. Recorded shape of a Bitrefill test-product delivery." : undefined,
        mode: "fixture",
      } as Order);
      return { ...inv };
    },
    async getInvoice(id) {
      await wait();
      const inv = invoices.get(id);
      if (!inv) throw new Error(`fake bitrefill: no invoice ${id}`);
      return { ...inv };
    },
    async getOrder(id) {
      await wait();
      const o = orders.get(id);
      if (!o) throw new Error(`fake bitrefill: no order ${id}`);
      return { ...o };
    },
  };
}

export function createFakeWallet(opts: { failSend?: boolean } = {}): WalletLike & { sent: ShieldedSend[] } {
  const sent: ShieldedSend[] = [];
  const addr = "utest1mockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmockmock";
  return {
    sent,
    async getAddress() {
      return addr;
    },
    async getBalance() {
      return { spendableZat: 50_000_000 };
    },
    async send(to, amountZat, memo) {
      if (opts.failSend) throw new Error("fake wallet: send failed");
      const txid = sha(`${to}|${amountZat}|${memo}|${Date.now()}|${Math.random()}`);
      const s = {
        txid,
        network: "testnet",
        amountZat,
        to,
        memo,
        confirmed: false,
        explorerUrl: `https://testnet.zcashexplorer.app/transactions/${txid}`,
        mode: "manual",
        mock: true,
      } as ShieldedSend & { mock: true };
      sent.push(s);
      return s;
    },
    async waitConfirmed() {
      return true;
    },
    async readMemos() {
      return sent.map((s) => ({ txid: s.txid, memo: s.memo }));
    },
  };
}

/** Deterministic dry-quote stand-in (rate ~ ZEC at $45). Labelled fixture. */
export async function fakeBridgeQuote(_refund: string | undefined, _recipient: string | undefined, usdAmount: number): Promise<BridgeQuote> {
  const zec = usdAmount / 45;
  return {
    kind: "dry",
    amountInZec: zec.toFixed(6),
    amountOutUsdc: usdAmount.toFixed(2),
    depositAddress: undefined,
    quoteId: `fx-quote-${Math.round(usdAmount * 100)}`,
    provider: "near-intents-1click",
    mode: "fixture",
  } as BridgeQuote;
}
