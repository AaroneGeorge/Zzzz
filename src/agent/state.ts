import type { PolicyDecision, RunState } from "../types";
import type { Mode } from "./deps";

export const STEP_DEFS = [
  { name: "search", title: "Search Bitrefill", tool: "search_products" },
  { name: "approve", title: "Policy gate", tool: "request_approval" },
  { name: "quote", title: "Quote ZEC → USDC (NEAR Intents)", tool: "quote_bridge" },
  { name: "invoice", title: "Gateway invoice (shielded payment request)", tool: "place_order(create)" },
  { name: "pay", title: "Shielded ZEC payment to the gateway", tool: "pay_shielded" },
  { name: "verify", title: "Gateway verified shielded payment (viewing key)", tool: "place_order(confirm) → gateway" },
  { name: "deliver", title: "Place Bitrefill order (only after verification)", tool: "place_order(confirm)" },
] as const;

export type StepName = (typeof STEP_DEFS)[number]["name"];

export interface StepDetail {
  title: string;
  tool: string;
  mode?: Mode;
  summary?: string;
  ids?: Record<string, string>;
  links?: Array<{ label: string; url: string }>;
  secret?: { label: string; value: string };
  data?: unknown;
  error?: string;
  /** privacy facts shown as a checklist (gateway step) */
  facts?: Array<{ label: string; holds: boolean }>;
}

export type RunStatus = "running" | "waiting_human" | "done" | "denied" | "rejected" | "failed";

/** RunState (shared contract) plus extra fields for the UI. */
export interface AgentRun extends RunState {
  prompt: string;
  agentMode: "llm" | "scripted";
  status: RunStatus;
  needsHuman: boolean;
  decision?: PolicyDecision;
  parsed?: unknown;
  notes: string[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
  steps: Array<RunState["steps"][number] & { detail?: StepDetail }>;
}

export function newRun(id: string, prompt: string, agentMode: "llm" | "scripted"): AgentRun {
  const at = new Date().toISOString();
  return {
    id,
    prompt,
    agentMode,
    status: "running",
    needsHuman: false,
    notes: [],
    createdAt: at,
    steps: STEP_DEFS.map((d) => ({ name: d.name, status: "pending" as const, at, detail: { title: d.title, tool: d.tool } })),
  };
}

export function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 14);
  return `run-${t}-${Math.random().toString(36).slice(2, 6)}`;
}
