import type { PolicyDecision } from "../types";
import { evaluate, spentToday } from "./evaluate";
import { buildMemo, hash8, policyHash } from "./hash";
import type { Ledger } from "./ledger";
import type { Policy, PolicyRequest } from "./types";

export class GateError extends Error {
  constructor(message: string) {
    super(`POLICY GATE: ${message}`);
    this.name = "GateError";
  }
}

export type GuardedAction = "create_invoice" | "pay_shielded" | "confirm_order";

interface RunRecord {
  req: PolicyRequest;
  decision: PolicyDecision;
  human?: boolean; // undefined = not asked yet
  spent: boolean;
}

/**
 * Stateful wrapper around the pure evaluate().
 * Every money-moving tool calls `authorize()` in code before it runs, so whatever the
 * model says, nothing is paid or ordered without an allowed decision (and a human click
 * when needed) for exactly the product and amount that was approved.
 */
export class PolicyGate {
  readonly hash: string;
  readonly hash8: string;
  private runs = new Map<string, RunRecord>();

  constructor(
    readonly policy: Policy,
    readonly ledger: Ledger,
    private clock: () => Date = () => new Date(),
  ) {
    this.hash = policyHash(policy);
    this.hash8 = hash8(this.hash);
  }

  /** Evaluate a request for a run and log the decision. A run gets one request; asking again replaces it. */
  request(runId: string, req: PolicyRequest): PolicyDecision {
    const decision = evaluate(this.policy, req, this.ledger.entries(), this.clock());
    this.runs.set(runId, { req: { ...req }, decision, spent: false });
    this.ledger.append({
      ts: this.clock().toISOString(),
      kind: "decision",
      runId,
      ...req,
      policyHash: this.hash,
      allowed: decision.allowed,
      needsHuman: decision.needsHuman,
      reasons: decision.reasons,
    });
    return decision;
  }

  /** A human answered the confirm prompt. Only meaningful for decisions that needed a human. */
  recordHuman(runId: string, approved: boolean): void {
    const r = this.runs.get(runId);
    if (!r) throw new GateError(`no decision for run ${runId}`);
    if (!r.decision.allowed) throw new GateError(`run ${runId} was denied; a human cannot override a denial`);
    r.human = approved;
    this.ledger.append({
      ts: this.clock().toISOString(),
      kind: "human",
      runId,
      ...r.req,
      policyHash: this.hash,
      approved,
    });
  }

  decisionFor(runId: string): PolicyDecision | undefined {
    return this.runs.get(runId)?.decision;
  }

  /**
   * Throws GateError unless the run has an allowed decision (plus a human yes if needed)
   * for this exact product and amount, and the request still fits the budget right now.
   */
  authorize(runId: string, action: GuardedAction, check: { productId?: string; amountInr?: number } = {}): PolicyRequest {
    const r = this.runs.get(runId);
    if (!r) throw new GateError(`${action} refused: request_approval was never called for this run`);
    if (!r.decision.allowed) throw new GateError(`${action} refused: the policy denied this purchase (${r.decision.reasons.filter((x) => !/ok|allow-listed|within/.test(x)).join("; ")})`);
    if (r.decision.needsHuman && r.human !== true) {
      throw new GateError(`${action} refused: ${r.human === false ? "the human rejected it" : "waiting for human confirmation"}`);
    }
    if (check.productId !== undefined && check.productId !== r.req.productId) {
      throw new GateError(`${action} refused: product ${check.productId} differs from approved ${r.req.productId}`);
    }
    if (check.amountInr !== undefined && Math.abs(check.amountInr - r.req.amountInr) > 0.005) {
      throw new GateError(`${action} refused: ₹${check.amountInr} differs from approved ₹${r.req.amountInr}`);
    }
    if (!r.spent) {
      // Re-check against the ledger as it is now (another run may have spent in between).
      const again = evaluate(this.policy, r.req, this.ledger.entries(), this.clock());
      if (!again.allowed) throw new GateError(`${action} refused on re-check: ${again.reasons.join("; ")}`);
    }
    return r.req;
  }

  /** Record that money moved for this run (counts toward budgets). Idempotent per run. */
  recordSpend(runId: string, info: { invoiceId?: string; txid?: string; mode?: string }): void {
    const r = this.runs.get(runId);
    if (!r) throw new GateError(`no decision for run ${runId}`);
    if (r.spent) return;
    r.spent = true;
    this.ledger.append({
      ts: this.clock().toISOString(),
      kind: "spend",
      runId,
      ...r.req,
      policyHash: this.hash,
      ...info,
    });
  }

  memo(invoiceId: string): string {
    return buildMemo(invoiceId, this.hash);
  }

  status() {
    const now = this.clock();
    const entries = this.ledger.entries();
    const spent = spentToday(this.policy, entries, now);
    const byCategory: Record<string, { spentInr: number; capInr: number }> = {};
    for (const [cat, cap] of Object.entries(this.policy.categoryCapsInr)) {
      byCategory[cat] = { spentInr: spentToday(this.policy, entries, now, cat), capInr: cap };
    }
    return {
      policy: this.policy,
      policyHash: this.hash,
      policyHash8: this.hash8,
      dailyBudgetInr: this.policy.dailyBudgetInr,
      confirmAboveInr: this.policy.confirmAboveInr,
      spentTodayInr: spent,
      remainingInr: Math.max(0, Math.round((this.policy.dailyBudgetInr - spent) * 100) / 100),
      byCategory,
      recent: entries.slice(-20),
    };
  }
}
