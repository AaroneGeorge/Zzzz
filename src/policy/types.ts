// Policy (mandate) types. Owned by T3. The shared contract (PolicyDecision) lives in src/types.ts.

export interface Policy {
  version: number;
  name?: string;
  /** IANA zone used to decide what "today" means for the daily budget. */
  timezone: string;
  dailyBudgetInr: number;
  /** Hard cap for one purchase, independent of the daily budget. */
  perTxMaxInr: number;
  /** Purchases strictly above this amount need a human click. */
  confirmAboveInr: number;
  /** Lower-case merchant ids the agent may pay. */
  merchantAllowList: string[];
  /** Per-category daily caps. A category that is not listed is denied. */
  categoryCapsInr: Record<string, number>;
  notes?: string;
}

export interface PolicyRequest {
  merchant: string;
  category: string;
  amountInr: number;
  productId: string;
}

/**
 * One line of the append-only JSONL audit log.
 * - decision: the gate evaluated a request (allowed or not)
 * - human:    a person confirmed or rejected a decision that needed a human
 * - spend:    money (or a test/mock stand-in for it) actually moved; counts toward budgets
 */
export interface LedgerEntry {
  ts: string;
  kind: "decision" | "human" | "spend";
  runId: string;
  merchant: string;
  category: string;
  amountInr: number;
  productId: string;
  policyHash: string;
  allowed?: boolean;
  needsHuman?: boolean;
  approved?: boolean;
  reasons?: string[];
  invoiceId?: string;
  txid?: string;
  mode?: string;
}
