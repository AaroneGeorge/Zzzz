// The five agent tools. Both llm and scripted mode go through this class, so the policy gate
// (gate.authorize) runs in code before every money-moving call, whatever the model says.
import type { BridgeQuote, Invoice, Order, PolicyDecision, Product, ShieldedSend } from "../types";
import { GateError } from "../policy";
import type { AgentConfig, AgentDeps, InvoiceItem, Mode } from "./deps";
import type { AgentRun, StepDetail, StepName } from "./state";

const MODES: Mode[] = ["real", "test", "quote", "fixture", "mock", "manual"];
function modeField(o: unknown): Mode | undefined {
  const m = (o as { mode?: unknown } | null)?.mode;
  return typeof m === "string" && (MODES as string[]).includes(m) ? (m as Mode) : undefined;
}

export const TEST_PRODUCT: Record<string, string> = {
  mobile_topup: "test-phone-refill",
  gift_card: "test-gift-card-code",
};

export class ToolError extends Error {}

interface Approved {
  productId: string;
  productName: string;
  amountInr: number;
  category: string;
  merchant: string;
  isTest: boolean;
  phone?: string;
  packageId?: string;
  value?: number;
}

export class AgentTools {
  private searched = new Map<string, Product & { category?: string }>();
  private approved?: Approved;
  private invoice?: Invoice;
  private quote?: BridgeQuote;
  private payment?: ShieldedSend;
  private order?: Order;

  constructor(
    readonly run: AgentRun,
    readonly deps: AgentDeps,
    readonly cfg: AgentConfig,
  ) {}

  // ---------- step bookkeeping ----------
  emit() {
    try {
      this.deps.onStep?.(this.run);
    } catch {
      /* UI callbacks must not break the run */
    }
  }

  step(name: StepName) {
    const s = this.run.steps.find((x) => x.name === name)!;
    return s;
  }

  setStep(name: StepName, status: AgentRun["steps"][number]["status"], patch: Partial<StepDetail> = {}) {
    const s = this.step(name);
    s.status = status;
    s.at = new Date().toISOString();
    s.detail = { ...(s.detail as StepDetail), ...patch };
    this.emit();
  }

  private async guarded<T>(name: StepName, fn: () => Promise<T>): Promise<T> {
    if (this.step(name).status === "ok") throw new ToolError(`step ${name} already completed for this run`);
    this.setStep(name, "running");
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      this.setStep(name, "failed", { error: msg, mode: this.step(name).detail?.mode ?? (e instanceof GateError ? "real" : undefined) });
      throw e;
    }
  }

  private bitrefillMode(o?: unknown, isTest = false): Mode {
    const f = modeField(o);
    if (f) return f;
    if (this.deps.sources?.bitrefill === "fake" || this.cfg.bitrefillMode === "offline") return "fixture";
    if (isTest || this.cfg.bitrefillMode === "test") return "test";
    return "real";
  }

  // ---------- 1. search_products ----------
  async search_products(input: { query: string; category: "mobile_topup" | "gift_card"; amount_inr?: number; phone?: string }) {
    return this.guarded("search", async () => {
      const q = String(input.query || "").trim();
      if (!q) throw new ToolError("query is required");
      const results = await this.deps.bitrefill.searchProducts(q, { country: "IN", includeTest: this.cfg.bitrefillMode !== "real" });
      const mode = this.bitrefillMode(results[0]);
      for (const p of results) this.searched.set(p.id, { ...p, category: (p as { category?: string }).category ?? input.category });

      // Outside "real" mode we never buy the real product: the matching Bitrefill test product is bought instead.
      let purchase: (Product & { category?: string }) | undefined;
      const amt = Number(input.amount_inr);
      // Best real match: most query words in the name, then a package worth exactly the requested amount.
      const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const giftRe = input.category === "gift_card" ? /voucher|gift/i : /recharge|top.?up|prepaid|mobile|bundle/i;
      const score = (p: Product) => words.filter((w) => p.name.toLowerCase().includes(w)).length * 10 + (giftRe.test(p.name) ? 5 : 0) + (p.value === amt ? 1 : 0);
      const real = results.filter((p) => !p.isTest).sort((x, y) => score(y) - score(x))[0];
      if (this.cfg.bitrefillMode === "real") {
        purchase = real;
      } else {
        const tid = TEST_PRODUCT[input.category] ?? TEST_PRODUCT.gift_card!;
        purchase = results.find((p) => p.id === tid) ?? { id: tid, name: `Bitrefill test product (${tid})`, currency: "USD", isTest: true, value: 10, category: input.category };
        this.searched.set(purchase.id, { ...purchase, category: input.category });
      }
      if (!purchase) throw new ToolError(`no Bitrefill product found for "${q}"`);

      const out = {
        mode,
        query: q,
        results: results.slice(0, 6).map((p) => ({ product_id: p.id, name: p.name, currency: p.currency, country: p.country, is_test: p.isTest, package_id: p.packageId, value: p.value })),
        recommended: {
          product_id: purchase.id,
          name: purchase.name,
          category: input.category,
          amount_inr: input.amount_inr,
          is_test: purchase.isTest,
          note: purchase.isTest
            ? `BITREFILL_MODE=${this.cfg.bitrefillMode}: the matched real product${real ? ` (${real.name})` : ""} is shown, but the order uses the free test product ${purchase.id}.`
            : "Real product: a real order will be placed after approval.",
        },
      };
      this.setStep("search", "ok", {
        mode,
        summary: `${results.length} result(s) for "${q}"${real ? ` → ${real.name}` : ""}${purchase.isTest ? ` · buying test product ${purchase.id}` : ""}`,
        ids: { query: q, matched: real?.id ?? "-", purchase: purchase.id },
        data: out,
      });
      return out;
    });
  }

  // ---------- 2. request_approval ----------
  async request_approval(input: { product_id: string; amount_inr: number; category: string; merchant?: string; phone?: string; reason?: string }) {
    return this.guarded("approve", async () => {
      if (this.step("search").status !== "ok") throw new ToolError("call search_products first");
      const p = this.searched.get(input.product_id);
      if (!p) throw new ToolError(`product ${input.product_id} was not returned by search_products`);
      const req = {
        merchant: input.merchant ?? "bitrefill",
        category: input.category,
        amountInr: Number(input.amount_inr),
        productId: input.product_id,
      };
      const gate = this.deps.policy;
      let decision: PolicyDecision = gate.request(this.run.id, req);
      this.run.decision = decision;
      const base: Partial<StepDetail> = {
        mode: "real",
        ids: { policy_hash: gate.hash8, run: this.run.id },
        data: { request: req, decision },
      };
      if (!decision.allowed) {
        this.run.status = "denied";
        this.setStep("approve", "failed", { ...base, summary: `DENIED: ${decision.reasons.filter((r) => !/ ok|allow-listed|within/.test(r)).join("; ")}` });
        return { approved: false, decision, message: "Denied by policy. Do not retry with a different amount or merchant; tell the user." };
      }
      let human: boolean | undefined;
      if (decision.needsHuman) {
        this.run.status = "waiting_human";
        this.run.needsHuman = true;
        this.setStep("approve", "running", { ...base, summary: `₹${req.amountInr} is above ₹${gate.policy.confirmAboveInr}: waiting for a human to confirm` });
        human = this.deps.confirm ? await this.deps.confirm(this.run) : false;
        gate.recordHuman(this.run.id, human);
        this.run.needsHuman = false;
        decision = gate.decisionFor(this.run.id)!;
        if (!human) {
          this.run.status = "rejected";
          this.setStep("approve", "failed", { ...base, mode: "manual", summary: `Human rejected ₹${req.amountInr}${this.deps.confirm ? "" : " (no confirm channel)"}` });
          return { approved: false, decision, human_confirmed: false, message: "A human rejected this purchase. Stop and tell the user." };
        }
        this.run.status = "running";
      }
      this.approved = {
        productId: p.id,
        productName: p.name,
        amountInr: req.amountInr,
        category: req.category,
        merchant: req.merchant,
        isTest: p.isTest,
        phone: input.phone,
        packageId: p.packageId,
        value: p.value,
      };
      this.setStep("approve", "ok", {
        ...base,
        mode: human ? "manual" : "real",
        summary: human
          ? `Approved by human click · ₹${req.amountInr} (₹${decision.remainingInr - req.amountInr} left today)`
          : `Auto-approved ₹${req.amountInr} (≤ ₹${gate.policy.confirmAboveInr}) · ₹${decision.remainingInr - req.amountInr} left today`,
      });
      return { approved: true, human_confirmed: human ?? null, decision, policy_hash8: gate.hash8 };
    });
  }

  // ---------- 3/6. place_order ----------
  async place_order(input: { action: "create" | "confirm"; product_id?: string; invoice_id?: string }) {
    if (input.action === "confirm") return this.confirmOrder(input.invoice_id);
    return this.guarded("invoice", async () => {
      const gate = this.deps.policy;
      const req = gate.authorize(this.run.id, "create_invoice", input.product_id ? { productId: input.product_id } : {});
      const a = this.approved;
      if (!a || a.productId !== req.productId) throw new ToolError("no approved product for this run");
      const item: InvoiceItem = {
        productId: a.productId,
        packageId: a.packageId,
        // Test products use their own (USD) package value; real Indian products the INR face value.
        value: a.value ?? (a.isTest ? 10 : a.amountInr),
        quantity: 1,
        ...(a.phone ? { phoneNumber: a.phone } : {}),
      };
      // Test products are paid from the (free) test balance; real ones get an unpaid usdc_base invoice.
      const paymentMethod = a.isTest ? "balance" : "usdc_base";
      const inv = await this.deps.bitrefill.createInvoice([item], paymentMethod, { autoPay: a.isTest });
      this.invoice = inv;
      const mode = this.bitrefillMode(inv, a.isTest);
      const ids: Record<string, string> = { invoice_id: inv.id, status: inv.status, payment_method: inv.paymentMethod };
      if (inv.orderIds?.[0]) ids.order_id = inv.orderIds[0];
      if (inv.payTo) ids.pay_to = `${inv.payTo.amount} ${inv.payTo.currency} → ${inv.payTo.address}`;
      this.setStep("invoice", "ok", {
        mode,
        summary: `Invoice ${inv.id} (${inv.status}) for ${a.productName}${a.isTest ? ` · free test stand-in for the approved ₹${a.amountInr}` : ` · ₹${a.amountInr}`}`,
        ids,
        data: inv,
      });
      return { mode, invoice: inv, memo_will_be: gate.memo(inv.id) };
    });
  }

  // ---------- 4. quote_bridge ----------
  async quote_bridge(input: { amount_inr?: number } = {}) {
    return this.guarded("quote", async () => {
      const a = this.approved;
      const inr = Number(input.amount_inr ?? a?.amountInr);
      if (!Number.isFinite(inr) || inr <= 0) throw new ToolError("amount_inr is required before approval");
      const usd = Math.round((inr / this.cfg.inrPerUsd) * 100) / 100;
      const refund = this.cfg.refundAddress ?? (await this.deps.wallet.getAddress());
      const payTo = this.invoice?.payTo;
      // Undefined lets the bridge module substitute its own labelled placeholder.
      const recipient = payTo && /usdc/i.test(payTo.currency) && /^0x/i.test(payTo.address) ? payTo.address : this.cfg.usdcRecipientFallback;
      const q = await this.deps.bridge(refund, recipient, usd);
      this.quote = q;
      const f = modeField(q);
      const mode: Mode = f ?? (this.deps.sources?.bridge === "fake" ? "fixture" : q.kind === "live" ? "real" : "quote");
      const ids: Record<string, string> = { provider: q.provider, kind: q.kind };
      if (q.quoteId) ids.quote_id = q.quoteId;
      if (q.depositAddress) ids.deposit_address = q.depositAddress;
      this.setStep("quote", "ok", {
        mode,
        summary: `${q.amountInZec} ZEC ≈ ${q.amountOutUsdc} USDC on Base for ₹${inr} (≈ $${usd} at ₹${this.cfg.inrPerUsd}/$) · ${q.kind === "dry" ? "quote only, nothing swapped" : "live quote"}`,
        ids,
        data: { recipient, recipientIsPlaceholder: !recipient, ...q, usd },
      });
      return { mode, quote: q, usd };
    });
  }

  // ---------- 5. pay_shielded ----------
  async pay_shielded(input: { invoice_id: string }) {
    return this.guarded("pay", async () => {
      const gate = this.deps.policy;
      gate.authorize(this.run.id, "pay_shielded");
      const inv = this.invoice;
      if (!inv) throw new ToolError("create the invoice (place_order create) before paying");
      if (input.invoice_id && input.invoice_id !== inv.id) throw new ToolError(`invoice ${input.invoice_id} is not this run's invoice (${inv.id})`);
      if (this.payment) throw new ToolError("already paid");
      const memo = gate.memo(inv.id);
      const to = this.cfg.destAddress ?? (await this.deps.wallet.getAddress());
      const amountZat = this.cfg.testnetSendZat;
      const send = await this.deps.wallet.send(to, amountZat, memo);
      this.payment = send;
      const isMock = (send as { mock?: boolean }).mock === true || (send.mode as string) === "mock" || this.cfg.walletKind === "mock" || this.deps.sources?.wallet === "fake";
      const mode: Mode = isMock ? "mock" : send.mode === "manual" ? "manual" : send.network === "mainnet" ? "real" : "test";
      gate.recordSpend(this.run.id, { invoiceId: inv.id, txid: send.txid, mode });
      const explorerUrl = send.explorerUrl || `https://testnet.zcashexplorer.app/transactions/${send.txid}`;
      this.setStep("pay", "ok", {
        mode,
        summary: `${(amountZat / 1e8).toFixed(8).replace(/0+$/, "")} ${send.network === "testnet" ? "TAZ" : "ZEC"} shielded on ${send.network} via ${isMock ? "mock wallet" : send.mode} · memo ${memo}${isMock ? " · MOCK txid, nothing on chain" : send.confirmed ? " · confirmed" : " · broadcast, waiting for a block"}`,
        ids: { txid: send.txid, memo, to: shorten(send.to), network: send.network },
        links: isMock ? [] : [{ label: "Zcash testnet explorer", url: explorerUrl }],
        data: { ...send, quotedMainnetZec: this.quote?.amountInZec },
      });
      if (!send.confirmed && !isMock && this.cfg.confirmWaitMs > 0) this.watchConfirm(send);
      return { mode, txid: send.txid, memo, network: send.network, explorer_url: isMock ? null : explorerUrl, confirmed: send.confirmed };
    });
  }

  private watchConfirm(send: ShieldedSend) {
    this.deps.wallet
      .waitConfirmed(send.txid, this.cfg.confirmWaitMs)
      .then((ok) => {
        if (!ok) return;
        const s = this.step("pay");
        const d = s.detail as StepDetail;
        d.summary = (d.summary ?? "").replace("broadcast, waiting for a block", "confirmed on-chain");
        d.data = { ...(d.data as object), confirmed: true };
        this.emit();
      })
      .catch(() => {});
  }

  private async confirmOrder(invoiceId?: string) {
    return this.guarded("deliver", async () => {
      const gate = this.deps.policy;
      gate.authorize(this.run.id, "confirm_order");
      if (!this.payment) throw new ToolError("pay_shielded must succeed before the order is confirmed");
      const inv0 = this.invoice!;
      if (invoiceId && invoiceId !== inv0.id) throw new ToolError(`invoice ${invoiceId} is not this run's invoice`);
      const isTest = this.approved?.isTest ?? false;
      let inv = inv0;
      try {
        inv = await this.deps.bitrefill.getInvoice(inv0.id);
      } catch {
        /* keep the creation snapshot */
      }
      const orderId = inv.orderIds?.[0] ?? inv0.orderIds?.[0];
      if (!orderId) {
        this.setStep("deliver", "skipped", { mode: this.bitrefillMode(inv, isTest), summary: `Invoice ${inv.id} is ${inv.status}: no order yet (awaiting payment, nothing delivered)`, ids: { invoice_id: inv.id, status: inv.status } });
        return { delivered: false, invoice_status: inv.status };
      }
      let order = await this.deps.bitrefill.getOrder(orderId);
      const deadline = Date.now() + this.cfg.orderPollMs;
      while (!order.code && !order.link && !/deliver|complete|success/i.test(order.status) && Date.now() < deadline && !/unpaid|awaiting/i.test(order.status + inv.status)) {
        await new Promise((r) => setTimeout(r, 2000));
        order = await this.deps.bitrefill.getOrder(orderId);
      }
      this.order = order;
      const mode = this.bitrefillMode(order, isTest);
      const delivered = Boolean(order.code || order.link || /deliver|complete|success/i.test(order.status));
      const detail: Partial<StepDetail> = {
        mode,
        ids: { order_id: order.id, invoice_id: inv.id, status: order.status },
        data: { ...order, code: order.code ? "(masked in UI)" : undefined },
        summary: delivered
          ? `${mode === "fixture" ? "Fixture order" : isTest ? "Test order" : "Order"} ${order.id} ${order.status}${order.instructions ? ` · ${order.instructions}` : ""}`
          : `Order ${order.id} is ${order.status} (not delivered; invoice ${inv.status})`,
      };
      if (order.code) detail.secret = { label: "Redemption code", value: order.code };
      if (order.link) detail.links = [{ label: "Redemption link", url: order.link }];
      this.setStep("deliver", delivered ? "ok" : "skipped", detail);
      return { delivered, mode, order_id: order.id, status: order.status, has_code: Boolean(order.code) };
    });
  }

  /** Mark everything still pending as skipped (run ended early). */
  finish() {
    for (const s of this.run.steps) if (s.status === "pending" || s.status === "running") {
      s.status = "skipped";
      s.at = new Date().toISOString();
    }
    // The quote is informational and delivery may legitimately wait for payment;
    // a run is "done" when search, approval, invoice and the shielded payment succeeded.
    const core = ["search", "approve", "invoice", "pay"].every((n) => this.step(n as StepName).status === "ok");
    if (this.run.status === "running" || this.run.status === "waiting_human") this.run.status = core ? "done" : "failed";
    this.run.needsHuman = false;
    this.run.finishedAt = new Date().toISOString();
    this.emit();
  }
}

function shorten(a: string): string {
  return a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a;
}
