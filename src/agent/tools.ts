// The five agent tools. Both llm and scripted mode go through this class, so the policy gate
// (gate.authorize) runs in code before every money-moving call, whatever the model says.
import type { BridgeQuote, Invoice, Order, PolicyDecision, Product, ShieldedSend } from "../types";
import { GateError } from "../policy";
import type { AgentConfig, AgentDeps, InvoiceItem, Mode } from "./deps";
import type { AgentRun, StepDetail, StepName } from "./state";
import { GatewayTimeout, MockGateway, testnetPriceZat, VIEW_LABEL, type Gateway, type GatewayInvoice, type GatewayVerification } from "../gateway";

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
  private gwInvoice?: GatewayInvoice;
  private brInvoice?: Invoice;
  private verification?: GatewayVerification;
  /** Set once the gate denies or a human rejects: a denial is final for the whole run, enforced here in code. */
  private finalDenial?: "denied" | "rejected";
  readonly gateway: Gateway;

  constructor(
    readonly run: AgentRun,
    readonly deps: AgentDeps,
    readonly cfg: AgentConfig,
  ) {
    this.gateway = deps.gateway ?? new MockGateway();
  }

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

  /** Refuse any further approval, quote, payment or order once this run was denied or rejected. */
  private assertNotDenied(tool: string) {
    const st = this.run.status;
    if (!this.finalDenial && (st === "denied" || st === "rejected")) this.finalDenial = st;
    if (!this.finalDenial) return;
    this.run.status = this.finalDenial; // a later call can never revive the run
    throw new ToolError(`${tool} refused: this run was ${this.finalDenial === "denied" ? "denied by the policy gate" : "rejected by a human"}, and a denial is final. Stop and tell the user; a new request needs a new run.`);
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
      const giftRe = input.category === "gift_card" ? /voucher|gift|shopping|amazon pay/i : /recharge|top.?up|prepaid|mobile|bundle/i;
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
    this.assertNotDenied("request_approval");
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
        this.finalDenial = "denied";
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
          this.finalDenial = "rejected";
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

  // ---------- 3. quote_bridge ----------
  async quote_bridge(input: { amount_inr?: number } = {}) {
    this.assertNotDenied("quote_bridge");
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

  // ---------- 4/7. place_order ----------
  async place_order(input: { action: "create" | "confirm"; product_id?: string; invoice_id?: string }) {
    this.assertNotDenied(`place_order(${input.action})`);
    if (input.action === "confirm") return this.confirmOrder(input.invoice_id);
    return this.guarded("invoice", async () => {
      const gate = this.deps.policy;
      const req = gate.authorize(this.run.id, "create_invoice", input.product_id ? { productId: input.product_id } : {});
      const a = this.approved;
      if (!a || a.productId !== req.productId) throw new ToolError("no approved product for this run");
      // The gateway (merchant side) issues the shielded payment request. The Bitrefill order is NOT created here:
      // it is placed only after the gateway has verified the shielded payment (step "verify").
      const gw = this.gateway;
      const price = testnetPriceZat(this.quote?.amountInZec);
      const g = gw.createInvoice({ runTag: this.run.id.replace(/^run-/, "").slice(-10), amountZat: price.amountZat, memoFor: (id) => gate.memo(id), quotedMainnetZec: this.quote?.amountInZec, pricing: price.pricing });
      this.gwInvoice = g;
      const inv: Invoice = { id: g.id, status: "unpaid", paymentMethod: "zcash_shielded_testnet", payTo: { address: g.address, amount: (g.amountZat / 1e8).toFixed(8), currency: "TAZ" }, orderIds: [] };
      this.invoice = inv;
      const mode: Mode = gw.view === "mock" ? "mock" : "test";
      this.setStep("invoice", "ok", {
        mode,
        summary: `Gateway invoice ${g.id}: pay ${(g.amountZat / 1e8).toFixed(5)} TAZ to the gateway's shielded address with memo ${g.memo} · ${price.pricing} · Bitrefill order for ${a.productName} is deferred until the gateway verifies the payment`,
        ids: { gateway_invoice: g.id, pay_to: shorten(g.address), amount: `${(g.amountZat / 1e8).toFixed(8)} TAZ (testnet stand-in)`, quoted_mainnet: this.quote ? `${this.quote.amountInZec} ZEC` : "-", memo: g.memo },
        data: { gatewayInvoice: g, approved: { product: a.productId, amountInr: a.amountInr } },
      });
      return { mode, invoice: inv, memo_will_be: g.memo, note: "Pay this gateway invoice with pay_shielded, then place_order confirm (the gateway verifies before the Bitrefill order is placed)." };
    });
  }

  // ---------- 5. pay_shielded ----------
  async pay_shielded(input: { invoice_id: string }) {
    this.assertNotDenied("pay_shielded");
    return this.guarded("pay", async () => {
      const gate = this.deps.policy;
      gate.authorize(this.run.id, "pay_shielded");
      const g = this.gwInvoice;
      if (!g) throw new ToolError("create the gateway invoice (place_order create) before paying");
      if (input.invoice_id && input.invoice_id !== g.id) throw new ToolError(`invoice ${input.invoice_id} is not this run's invoice (${g.id})`);
      if (this.payment) throw new ToolError("already paid");
      const memo = gate.memo(g.id);
      const real = this.cfg.walletKind === "zingo" && this.deps.sources?.wallet !== "fake";
      this.setStep("pay", "running", {
        mode: real ? "test" : undefined,
        summary: real
          ? `Broadcasting: zingo-cli syncs, builds the shielded proof and broadcasts ${(g.amountZat / 1e8).toFixed(5)} TAZ to the gateway (≈30–60 s)…`
          : "Sending…",
      });
      const send = await this.deps.wallet.send(g.address, g.amountZat, memo);
      this.payment = send;
      const isMock = (send as { mock?: boolean }).mock === true || (send.mode as string) === "mock" || this.cfg.walletKind === "mock" || this.deps.sources?.wallet === "fake";
      const mode: Mode = isMock ? "mock" : send.mode === "manual" ? "manual" : send.network === "mainnet" ? "real" : "test";
      gate.recordSpend(this.run.id, { invoiceId: g.id, txid: send.txid, mode });
      const explorerUrl = send.explorerUrl || `https://testnet.zcashexplorer.app/transactions/${send.txid}`;
      this.setStep("pay", "ok", {
        mode,
        summary: `${(g.amountZat / 1e8).toFixed(5)} ${send.network === "testnet" ? "TAZ" : "ZEC"} shielded on ${send.network} via ${isMock ? "mock wallet" : send.mode} to the gateway · memo ${memo}${isMock ? " · MOCK txid, nothing on chain" : " · broadcast, waiting for a block"}`,
        ids: { txid: send.txid, memo, to: `gateway ${shorten(send.to)}`, network: send.network },
        links: isMock ? [] : [{ label: "Zcash testnet explorer", url: explorerUrl }],
        data: { ...send, quotedMainnetZec: this.quote?.amountInZec, pricing: g.pricing },
      });
      return { mode, txid: send.txid, memo, network: send.network, explorer_url: isMock ? null : explorerUrl, next: "call place_order with action confirm; the gateway verifies the payment first" };
    });
  }

  // ---------- 6. gateway verification (runs inside place_order confirm, in code) ----------
  private async verifyPayment(): Promise<GatewayVerification> {
    if (this.verification) return this.verification;
    return this.guarded("verify", async () => {
      const g = this.gwInvoice;
      const send = this.payment;
      if (!g || !send) throw new ToolError("pay_shielded must succeed before the gateway can verify");
      const gw = this.gateway;
      const mode: Mode = gw.view === "mock" ? "mock" : "test";
      const how = VIEW_LABEL[gw.view];
      this.setStep("verify", "running", { mode, summary: `Gateway is scanning with its ${how} for memo ${g.memo} and ≥ ${(g.amountZat / 1e8).toFixed(5)} TAZ…` });
      const started = Date.now();
      try {
        const v = await gw.waitForPayment(g, {
          timeoutMs: this.cfg.gatewayTimeoutMs,
          sent: { txid: send.txid, amountZat: send.amountZat, memo: send.memo, to: send.to },
          onProgress: (p) => {
            const secs = Math.round((Date.now() - started) / 1000);
            this.setStep("verify", "running", {
              mode,
              summary: p.inMempool
                ? `Gateway sees tx ${p.inMempool.txid.slice(0, 10)}… with the right memo in the mempool · waiting for it to be mined (${secs} s, poll ${p.polls})`
                : `Gateway scanning (${how}) · not seen yet (${secs} s, poll ${p.polls})${p.lastError ? ` · retrying after: ${p.lastError.slice(0, 120)}` : ""}`,
            });
          },
        });
        this.verification = v;
        const pay = this.step("pay");
        const pd = pay.detail as StepDetail;
        if (v.height) {
          pd.summary = (pd.summary ?? "").replace("broadcast, waiting for a block", `mined at height ${v.height.toLocaleString("en-US")}`);
          pd.ids = { ...(pd.ids ?? {}), height: String(v.height) };
        }
        pd.data = { ...(pd.data as object), confirmed: true, height: v.height };
        this.setStep("verify", "ok", {
          mode,
          summary: `Verified ${(v.amountZat / 1e8).toFixed(5)} TAZ (≥ ${(g.amountZat / 1e8).toFixed(5)} expected) with memo ${v.memo}${v.height ? ` · mined at height ${v.height.toLocaleString("en-US")}` : ""} · decrypted by the ${how}`,
          ids: { txid: v.txid, height: v.height ? String(v.height) : "-", amount: `${v.amountZat} zat`, memo: v.memo, gateway_invoice: g.id, view: gw.view },
          links: gw.view === "mock" ? [] : [{ label: "Explorer (shows only 'shielded')", url: `https://testnet.zcashexplorer.app/transactions/${v.txid}` }],
          facts: [
            { label: "On chain the amount, sender, recipient and memo are encrypted; the explorer shows only a shielded tx and its fee", holds: gw.view !== "mock" },
            { label: "The gateway decrypts amount + memo with its viewing key" + (gw.view === "ufvk" ? " (view-only UFVK wallet: it cannot spend)" : gw.view === "wallet" ? " (here: its full wallet; UFVK wallet unavailable)" : " (mock)"), holds: gw.view !== "mock" },
            { label: "The gateway never learns the agent's address (shielded sender)", holds: true },
            { label: "Bitrefill sees only the order for the invoice, never a Zcash address, txid or memo", holds: true },
            { label: "Caveat: the lightwalletd server sees our IP (this build runs without the Nym mixnet)", holds: gw.view !== "mock" },
          ],
          data: { verification: v, pricing: g.pricing },
        });
        return v;
      } catch (e) {
        if (e instanceof GatewayTimeout) {
          this.setStep("deliver", "skipped", { mode: this.bitrefillMode(undefined, true), summary: "NOT placed: the gateway did not verify the shielded payment, so no Bitrefill order was created" });
          throw new ToolError(`${e.message}. No Bitrefill order was placed.`);
        }
        throw e;
      }
    });
  }

  private async confirmOrder(invoiceId?: string) {
    if (!this.payment) {
      // gate first (so an unapproved model sees POLICY GATE), then the payment check
      this.deps.policy.authorize(this.run.id, "confirm_order");
      throw new ToolError("pay_shielded must succeed before the order is confirmed");
    }
    if (invoiceId && this.gwInvoice && invoiceId !== this.gwInvoice.id && invoiceId !== this.brInvoice?.id) throw new ToolError(`invoice ${invoiceId} is not this run's invoice`);
    const v = await this.verifyPayment(); // throws (and skips deliver) if the gateway can't verify
    return this.guarded("deliver", async () => {
      const gate = this.deps.policy;
      gate.authorize(this.run.id, "confirm_order");
      if (!v.verified) throw new ToolError("gateway verification missing");
      const a = this.approved!;
      const isTest = a.isTest;
      const item: InvoiceItem = {
        productId: a.productId,
        packageId: a.packageId,
        // Test products use their own (USD) package value; real Indian products the INR face value.
        value: a.value ?? (isTest ? 10 : a.amountInr),
        quantity: 1,
        ...(a.phone ? { phoneNumber: a.phone } : {}),
      };
      // Test products are paid from the (free) test balance with auto_pay; a real product only ever gets an
      // UNPAID usdc_base invoice (shown as awaiting payment, never claimed paid).
      const paymentMethod = isTest ? "balance" : "usdc_base";
      let inv = await this.deps.bitrefill.createInvoice([item], paymentMethod, { autoPay: isTest });
      this.brInvoice = inv;
      const deadline = Date.now() + this.cfg.orderPollMs;
      while (!inv.orderIds?.[0] && isTest && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          inv = await this.deps.bitrefill.getInvoice(inv.id);
        } catch {
          break;
        }
      }
      const orderId = inv.orderIds?.[0];
      if (!orderId) {
        this.setStep("deliver", "skipped", { mode: this.bitrefillMode(inv, isTest), summary: `Bitrefill invoice ${inv.id} is ${inv.status}: no order yet (awaiting payment, nothing delivered)`, ids: { bitrefill_invoice: inv.id, status: inv.status, gateway_txid: v.txid } });
        return { delivered: false, invoice_status: inv.status };
      }
      let order = await this.deps.bitrefill.getOrder(orderId);
      while (!order.code && !order.link && !/deliver|complete|success/i.test(order.status) && Date.now() < deadline && !/unpaid|awaiting/i.test(order.status + inv.status)) {
        await new Promise((r) => setTimeout(r, 2000));
        order = await this.deps.bitrefill.getOrder(orderId);
      }
      this.order = order;
      const mode = this.bitrefillMode(order, isTest);
      const delivered = Boolean(order.code || order.link || /deliver|complete|success/i.test(order.status));
      const detail: Partial<StepDetail> = {
        mode,
        ids: { bitrefill_invoice: inv.id, order_id: order.id, status: order.status, unlocked_by: `gateway ${v.invoiceId} · tx ${v.txid.slice(0, 12)}…` },
        data: { ...order, code: order.code ? "(masked in UI)" : undefined, invoice: inv },
        summary: delivered
          ? `${mode === "fixture" ? "Fixture order" : isTest ? "Bitrefill TEST order" : "Order"} ${order.id} ${order.status}, placed after the gateway verified tx ${v.txid.slice(0, 10)}…${isTest ? ` · free test stand-in for the approved ₹${a.amountInr} ${a.productName === a.productId ? "" : ""}`.trimEnd() : ""}${order.instructions ? ` · ${order.instructions}` : ""}`
          : `Order ${order.id} is ${order.status} (not delivered; invoice ${inv.status})`,
      };
      if (order.code) detail.secret = { label: "Redemption code", value: order.code };
      if (order.link) detail.links = [{ label: "Redemption link", url: order.link }];
      this.setStep("deliver", delivered ? "ok" : "skipped", detail);
      return { delivered, mode, order_id: order.id, bitrefill_invoice: inv.id, status: order.status, has_code: Boolean(order.code), verified_txid: v.txid, height: v.height };
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
    const core = ["search", "approve", "invoice", "pay", "verify"].every((n) => this.step(n as StepName).status === "ok");
    if (this.finalDenial) this.run.status = this.finalDenial;
    else if (this.run.status === "running" || this.run.status === "waiting_human") this.run.status = core ? "done" : "failed";
    this.run.needsHuman = false;
    this.run.finishedAt = new Date().toISOString();
    this.emit();
  }
}

function shorten(a: string): string {
  return a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a;
}
