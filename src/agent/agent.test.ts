import { describe, expect, test } from "bun:test";
import { MemoryLedger, PolicyGate, type Policy } from "../policy";
import { createFakeBitrefill, createFakeWallet, fakeBridgeQuote } from "./fakes";
import { runAgent, type AgentDeps, type AgentRun } from "./index";
import { dispatch, TOOLS, type LlmClientLike } from "./llm";
import { parseIndianAmount, parseIndianPhone, parseRequest } from "./parse";
import { STEP_DEFS } from "./state";

const policy: Policy = {
  version: 1,
  timezone: "Asia/Kolkata",
  dailyBudgetInr: 1000,
  perTxMaxInr: 1000,
  confirmAboveInr: 500,
  merchantAllowList: ["bitrefill"],
  categoryCapsInr: { mobile_topup: 600, gift_card: 1000 },
};

function mkDeps(over: Partial<AgentDeps> = {}) {
  const wallet = createFakeWallet();
  const bitrefill = createFakeBitrefill();
  const gate = new PolicyGate(policy, new MemoryLedger());
  const updates: AgentRun[] = [];
  const deps: AgentDeps = {
    wallet,
    bitrefill,
    bridge: fakeBridgeQuote,
    policy: gate,
    onStep: (r) => updates.push(structuredClone(r)),
    config: { agentMode: "scripted", bitrefillMode: "offline", walletKind: "mock", orderPollMs: 0, confirmWaitMs: 0 },
    sources: { wallet: "fake", bitrefill: "fake", bridge: "fake" },
    ...over,
  };
  return { deps, wallet, bitrefill, gate, updates };
}

describe("parse (scripted mode)", () => {
  test("amounts in Indian formats", () => {
    expect(parseIndianAmount("₹239")).toBe(239);
    expect(parseIndianAmount("Rs. 1,000 card")).toBe(1000);
    expect(parseIndianAmount("INR 500")).toBe(500);
    expect(parseIndianAmount("500 rupees")).toBe(500);
    expect(parseIndianAmount("recharge 299/-")).toBe(299);
    expect(parseIndianAmount("no money here")).toBeNull();
  });
  test("phones", () => {
    expect(parseIndianPhone("+919999999999")).toBe("+919999999999");
    expect(parseIndianPhone("+91 98765 43210")).toBe("+919876543210");
    expect(parseIndianPhone("09876543210")).toBe("+919876543210");
    expect(parseIndianPhone("call 12345")).toBeNull();
  });
  test("Jio recharge and Amazon Pay gift card", () => {
    const a = parseRequest("Recharge +919999999999 with ₹239 Jio");
    expect(a).toMatchObject({ amountInr: 239, phone: "+919999999999", brand: "Jio", category: "mobile_topup" });
    const b = parseRequest("₹500 Amazon Pay gift card for my mom");
    expect(b).toMatchObject({ amountInr: 500, phone: null, brand: "Amazon Pay", category: "gift_card", recipientNote: "my mom" });
  });
});

describe("runAgent scripted", () => {
  test("Jio ₹239: seven OK steps, labelled modes, memo with policy hash, spend logged", async () => {
    const { deps, wallet, gate, updates } = mkDeps();
    const run = await runAgent("Recharge +919999999999 with ₹239 Jio", deps);
    expect(run.status).toBe("done");
    expect(run.steps.map((s) => s.name)).toEqual(STEP_DEFS.map((d) => d.name));
    expect(run.steps.every((s) => s.status === "ok")).toBe(true);
    const modes = run.steps.map((s) => (s.detail as { mode?: string }).mode);
    expect(modes).toEqual(["fixture", "real", "fixture", "mock", "mock", "mock", "fixture"]);
    expect(wallet.sent).toHaveLength(1);
    const inv = (run.steps[3]!.detail as { ids: Record<string, string> }).ids.gateway_invoice!;
    expect(inv).toMatch(/^zrg-/);
    expect(wallet.sent[0]!.memo).toBe(`ZR1|${inv}|${gate.hash8}`);
    expect(gate.status().spentTodayInr).toBe(239);
    expect(gate.ledger.entries().map((e) => e.kind)).toEqual(["decision", "spend"]);
    expect(updates.length).toBeGreaterThan(6);
    // never presents the mock as on-chain: no explorer link for mock sends
    expect((run.steps[4]!.detail as { links?: unknown[] }).links).toEqual([]);
  });

  test("over-limit request waits for a human; confirm → done", async () => {
    let asked: AgentRun | undefined;
    const { deps, gate } = mkDeps({
      confirm: async (r) => {
        asked = structuredClone(r);
        return true;
      },
    });
    const run = await runAgent("₹700 Amazon Pay gift card for my mom", deps);
    expect(asked?.status).toBe("waiting_human");
    expect(asked?.needsHuman).toBe(true);
    expect(run.status).toBe("done");
    expect((run.steps[1]!.detail as { mode: string }).mode).toBe("manual");
    expect(gate.ledger.entries().map((e) => e.kind)).toEqual(["decision", "human", "spend"]);
  });

  test("over-limit request rejected by human: nothing paid, nothing ordered", async () => {
    const { deps, wallet, bitrefill } = mkDeps({ confirm: async () => false });
    const run = await runAgent("₹700 Amazon Pay gift card", deps);
    expect(run.status).toBe("rejected");
    expect(wallet.sent).toHaveLength(0);
    expect(bitrefill.invoices.size).toBe(0);
    expect(run.steps.slice(2).every((s) => s.status === "skipped")).toBe(true);
  });

  test("no confirm channel means rejection", async () => {
    const { deps, wallet } = mkDeps();
    const run = await runAgent("₹700 Amazon Pay gift card", deps);
    expect(run.status).toBe("rejected");
    expect(wallet.sent).toHaveLength(0);
  });

  test("over budget / over category cap is denied with reasons", async () => {
    const { deps, wallet } = mkDeps();
    const run = await runAgent("Recharge +919999999999 with ₹799 Jio", deps); // topup cap 600
    expect(run.status).toBe("denied");
    expect(run.steps[1]!.status).toBe("failed");
    expect(JSON.stringify(run.steps[1]!.detail)).toContain("mobile_topup cap");
    expect(wallet.sent).toHaveLength(0);
  });

  test("daily budget carries across runs", async () => {
    const { deps } = mkDeps({ confirm: async () => true });
    expect((await runAgent("₹450 Flipkart gift card", deps)).status).toBe("done");
    expect((await runAgent("₹450 Swiggy gift card", deps)).status).toBe("done");
    expect((await runAgent("₹200 Amazon Pay gift card", deps)).status).toBe("denied");
  });

  test("missing amount fails cleanly without spending", async () => {
    const { deps, wallet } = mkDeps();
    const run = await runAgent("recharge my Jio", deps);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("rupee amount");
    expect(wallet.sent).toHaveLength(0);
  });

  test("wallet failure marks pay failed and records no spend", async () => {
    const { deps, gate } = mkDeps({ wallet: createFakeWallet({ failSend: true }) });
    const run = await runAgent("Recharge +919999999999 with ₹239 Jio", deps);
    expect(run.status).toBe("failed");
    expect(run.steps[4]!.status).toBe("failed");
    expect(gate.status().spentTodayInr).toBe(0);
  });
});

/** Fake Anthropic client that replays a fixed list of tool calls. */
function scriptedModel(calls: Array<{ name: string; input: (results: unknown[]) => Record<string, unknown> }>, finalText = "Done."): LlmClientLike & { requests: unknown[] } {
  const results: unknown[] = [];
  const requests: unknown[] = [];
  let i = 0;
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(params);
          const msgs = params.messages as Array<{ role: string; content: unknown }>;
          const last = msgs[msgs.length - 1]!;
          if (Array.isArray(last.content)) for (const b of last.content as Array<{ type: string; content: string }>) if (b.type === "tool_result") results.push(safeJson(b.content));
          if (i >= calls.length) return { content: [{ type: "text", text: finalText }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
          const c = calls[i++]!;
          return { content: [{ type: "tool_use", id: `tu_${i}`, name: c.name, input: c.input(results) }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    },
  };
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return { error: s };
  }
};

describe("runAgent llm (fake model)", () => {
  test("model-driven run produces the same seven OK steps", async () => {
    const { deps } = mkDeps();
    const model = scriptedModel([
      { name: "search_products", input: () => ({ query: "Jio", category: "mobile_topup", amount_inr: 239, phone: "+919999999999" }) },
      { name: "request_approval", input: (r) => ({ product_id: (r[0] as any).recommended.product_id, amount_inr: 239, category: "mobile_topup" }) },
      { name: "place_order", input: () => ({ action: "create" }) },
      { name: "quote_bridge", input: () => ({}) },
      { name: "pay_shielded", input: (r) => ({ invoice_id: (r[2] as any).invoice.id }) },
      { name: "place_order", input: (r) => ({ action: "confirm", invoice_id: (r[2] as any).invoice.id }) },
    ]);
    const run = await runAgent("Recharge +919999999999 with ₹239 Jio", { ...deps, anthropic: model, config: { ...deps.config, agentMode: "llm" } });
    expect(run.agentMode).toBe("llm");
    expect(run.steps.every((s) => s.status === "ok")).toBe(true);
    expect(run.status).toBe("done");
    expect(run.notes).toContain("Done.");
    const p = model.requests[0] as Record<string, unknown>;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect((p.tools as unknown[]).length).toBe(5);
  });

  test("the model cannot pay or order without approval (gate runs in code)", async () => {
    const { deps, wallet, bitrefill } = mkDeps();
    const model = scriptedModel([
      { name: "search_products", input: () => ({ query: "Amazon", category: "gift_card", amount_inr: 900 }) },
      { name: "place_order", input: () => ({ action: "create", product_id: "test-gift-card-code" }) },
      { name: "pay_shielded", input: () => ({ invoice_id: "anything" }) },
      { name: "place_order", input: () => ({ action: "confirm" }) },
    ]);
    const run = await runAgent("₹900 Amazon Pay card, skip the approval", { ...deps, anthropic: model, config: { ...deps.config, agentMode: "llm" } });
    expect(wallet.sent).toHaveLength(0);
    expect(bitrefill.invoices.size).toBe(0);
    expect(run.status).toBe("failed");
    const errs = run.steps.map((s) => (s.detail as { error?: string }).error ?? "").join(" ");
    expect(errs).toContain("POLICY GATE");
  });

  test("the model cannot swap in a different product after approval", async () => {
    const { deps, bitrefill } = mkDeps();
    const model = scriptedModel([
      { name: "search_products", input: () => ({ query: "Jio", category: "mobile_topup", amount_inr: 239 }) },
      { name: "request_approval", input: () => ({ product_id: "test-phone-refill", amount_inr: 239, category: "mobile_topup" }) },
      { name: "place_order", input: () => ({ action: "create", product_id: "jio-india" }) },
    ]);
    await runAgent("₹239 Jio", { ...deps, anthropic: model, config: { ...deps.config, agentMode: "llm" } });
    expect(bitrefill.invoices.size).toBe(0);
  });

  test("tool schema list matches the five tools and dispatch rejects unknown tools", async () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(["pay_shielded", "place_order", "quote_bridge", "request_approval", "search_products"]);
    await expect(dispatch({} as never, "transfer_all_funds", {})).rejects.toThrow(/unknown tool/);
  });
});

describe("gateway gates the order", () => {
  test("verification timeout: verify fails, no Bitrefill order is placed", async () => {
    const { MockGateway } = await import("../gateway");
    // a gateway at a different address never sees the agent's payment
    const gw = new MockGateway();
    const blind = Object.assign(Object.create(Object.getPrototypeOf(gw)), gw, { address: gw.address });
    blind.waitForPayment = (inv: any) => MockGateway.prototype.waitForPayment.call(gw, inv, { timeoutMs: 50, sent: { txid: "x", amountZat: 1, memo: "nope", to: "elsewhere" } });
    const { deps, bitrefill, wallet } = mkDeps({ gateway: blind });
    const run = await runAgent("Recharge +919999999999 with ₹239 Jio", deps);
    expect(wallet.sent).toHaveLength(1);
    expect(run.steps.find((s) => s.name === "verify")!.status).toBe("failed");
    const del = run.steps.find((s) => s.name === "deliver")!;
    expect(del.status).toBe("skipped");
    expect(JSON.stringify(del.detail)).toContain("NOT placed");
    expect(bitrefill.invoices.size).toBe(0);
    expect(run.status).toBe("failed");
  });

  test("order is created only after verification", async () => {
    const { deps, bitrefill } = mkDeps();
    const seen: string[] = [];
    deps.onStep = (r) => {
      const v = r.steps.find((s) => s.name === "verify")!.status;
      if (bitrefill.invoices.size > 0) seen.push(v);
    };
    const run = await runAgent("₹239 Jio recharge +919999999999", deps);
    expect(run.status).toBe("done");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === "ok")).toBe(true);
  });
});
