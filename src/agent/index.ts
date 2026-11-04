import { FileLedger, loadPolicy, PolicyGate, DEFAULT_LEDGER_PATH } from "../policy";
import { configFromEnv, loadAdapters, type AgentConfig, type AgentDeps } from "./deps";
import { runLlmLoop, type LlmClientLike } from "./llm";
import { parseRequest } from "./parse";
import { newRun, newRunId, type AgentRun } from "./state";
import { AgentTools } from "./tools";

export * from "./deps";
export * from "./state";
export { parseRequest } from "./parse";
export { AgentTools } from "./tools";

/**
 * Run one purchase request end to end. Emits the RunState after every change via deps.onStep.
 * AGENT_MODE (or deps.config.agentMode) picks llm or scripted; both use the same tools and gate.
 */
export async function runAgent(prompt: string, deps: AgentDeps & { runId?: string }): Promise<AgentRun> {
  const cfg: AgentConfig = { ...configFromEnv(), ...(deps.config ?? {}) };
  const run = newRun(deps.runId ?? newRunId(), prompt, cfg.agentMode);
  const tools = new AgentTools(run, deps, cfg);
  tools.emit();
  try {
    if (cfg.agentMode === "llm") {
      await runLlmLoop(tools, prompt, deps.anthropic as LlmClientLike | undefined);
    } else {
      await runScripted(tools, prompt);
    }
  } catch (e) {
    run.error = (e as Error).message;
    if (run.status === "running" || run.status === "waiting_human") run.status = "failed";
  } finally {
    tools.finish();
  }
  return run;
}

/** The same six steps without an LLM: deterministic parse, then fixed tool order. */
export async function runScripted(tools: AgentTools, prompt: string): Promise<void> {
  const run = tools.run;
  const p = parseRequest(prompt);
  run.parsed = p;
  run.notes.push(`[scripted] parsed: ${p.brand ?? "?"} · ${p.category} · ₹${p.amountInr ?? "?"}${p.phone ? ` · ${p.phone}` : ""}`);
  if (p.amountInr === null) throw new Error("no rupee amount in the request (try “₹239”)");

  const s = await tools.search_products({ query: p.query, category: p.category, amount_inr: p.amountInr, phone: p.phone ?? undefined });
  const a = await tools.request_approval({
    product_id: s.recommended.product_id,
    amount_inr: p.amountInr,
    category: p.category,
    merchant: "bitrefill",
    phone: p.phone ?? undefined,
  });
  if (!a.approved) return;
  const inv = await tools.place_order({ action: "create", product_id: s.recommended.product_id });
  try {
    await tools.quote_bridge({ amount_inr: p.amountInr });
  } catch (e) {
    run.notes.push(`quote failed (non-fatal): ${(e as Error).message}`);
  }
  if (!("invoice" in inv)) return;
  await tools.pay_shielded({ invoice_id: inv.invoice.id });
  await tools.place_order({ action: "confirm", invoice_id: inv.invoice.id });
}

/** Build deps from env + the real modules (or fakes). One gate per process. */
export async function createDefaultDeps(opts: { ledgerPath?: string } = {}) {
  const adapters = await loadAdapters();
  const gate = new PolicyGate(loadPolicy(), new FileLedger(opts.ledgerPath ?? process.env.LEDGER_PATH ?? DEFAULT_LEDGER_PATH));
  return { ...adapters, policy: gate };
}
