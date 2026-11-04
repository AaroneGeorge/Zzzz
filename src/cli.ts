#!/usr/bin/env bun
// bun run demo -- "Recharge +919999999999 with ₹239 Jio"
// Flags: --yes / --no (answer the human-confirm prompt), --reset-ledger (operator: archive today's ledger), --json
import { createInterface } from "node:readline/promises";
import { FileLedger, DEFAULT_LEDGER_PATH } from "./policy";
import { configFromEnv, createDefaultDeps, runAgent, type AgentRun, type StepDetail } from "./agent";

import { promptFromArgs } from "./agent/parse";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const USAGE = 'usage: bun run demo -- [--yes|--no] [--json] [--reset-ledger] "Recharge +919999999999 with ₹239 Jio"';
const parsedArgs = promptFromArgs(args);
if ("error" in parsedArgs && !(flags.has("--reset-ledger") && args.length === 1)) {
  console.error(`error: ${parsedArgs.error}\n${USAGE}`);
  process.exit(2);
}
const prompt = "prompt" in parsedArgs ? parsedArgs.prompt : "";

const TAGLINE = "Agent pays shielded ZEC to a viewing-key gateway; only a verified payment unlocks the Bitrefill order (testnet + Bitrefill test products)";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const ICON: Record<string, string> = { ok: c("32", "OK  "), failed: c("31", "FAIL"), skipped: c("90", "SKIP"), running: c("33", "... "), pending: c("90", "    ") };
const MODE_COLOR: Record<string, string> = { real: "42;30", test: "46;30", quote: "45;30", fixture: "43;30", mock: "47;30", manual: "44;37" };

async function main() {
  const ledgerPath = process.env.LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
  if (flags.has("--reset-ledger")) {
    const moved = new FileLedger(ledgerPath).archive();
    console.log(moved ? `ledger archived to ${moved}` : "ledger was empty");
    if (args.length === 1) return;
  }
  const cfg = configFromEnv();
  const deps = await createDefaultDeps({ ledgerPath });
  console.log(c("90", TAGLINE));
  console.log(c("1", `ZecRecharge · agent=${cfg.agentMode} · bitrefill=${cfg.bitrefillMode} · wallet=${cfg.walletKind} · gateway=${deps.gateway.view} · network=${cfg.network}`));
  console.log(`sources: wallet=${deps.sources.wallet} bitrefill=${deps.sources.bitrefill} bridge=${deps.sources.bridge} · policy ${deps.policy.hash8}`);
  for (const w of deps.warnings) console.log(c("90", `  note: ${w}`));
  console.log(`request: "${prompt}"\n`);

  const printed = new Set<string>();
  const run = await runAgent(prompt, {
    ...deps,
    onStep: (r) => {
      for (const s of r.steps) {
        const key = `${s.name}:${s.status}`;
        if ((s.status === "running" && s.name === "approve" && r.status === "waiting_human") && !printed.has("wait")) {
          printed.add("wait");
          console.log(c("33", `      ⏸  ${(s.detail as StepDetail).summary}`));
        }
        if (s.status === "running" && (s.name === "pay" || s.name === "verify")) {
          const sum = (s.detail as StepDetail).summary ?? "";
          const k2 = `${s.name}:run:${sum.replace(/\(\d+ s, poll \d+\)/, "")}`;
          if (sum && !printed.has(k2)) {
            printed.add(k2);
            console.log(c("33", `  …  ${sum}`));
          }
        }
        if (s.status === "pending" || s.status === "running" || printed.has(key)) continue;
        printed.add(key);
        printStep(r, s.name);
      }
    },
    confirm: async (r) => {
      if (flags.has("--yes") || process.env.AUTO_CONFIRM === "yes") return true;
      if (flags.has("--no") || process.env.AUTO_CONFIRM === "no" || !process.stdin.isTTY) {
        console.log(c("33", "      no human confirmation available (use --yes, or the web UI): rejecting"));
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const amt = (r.decision as { spentTodayInr: number } | undefined) ? "" : "";
      const ans = await rl.question(c("1", `      Confirm this purchase${amt}? [y/N] `));
      rl.close();
      return /^y(es)?$/i.test(ans.trim());
    },
  });

  console.log("");
  for (const n of run.notes) console.log(c("90", n.startsWith("[") ? n : `agent: ${n}`));
  const okCount = run.steps.filter((s) => s.status === "ok").length;
  const st = deps.policy.status();
  console.log(`\nrun ${run.id}: ${c("1", run.status.toUpperCase())} · ${okCount}/${run.steps.length} steps OK · budget ₹${st.spentTodayInr} spent, ₹${st.remainingInr} left today · ledger ${ledgerPath}`);
  if (run.error) console.log(c("31", `error: ${run.error}`));
  if (run.status === "denied" || run.status === "rejected") {
    const appr = run.steps.find((s) => s.name === "approve")?.detail as StepDetail | undefined;
    const why = run.status === "denied" ? (appr?.summary ?? "DENIED by the policy gate").replace(/^DENIED:\s*/, "") : "a human rejected the purchase";
    console.log(c("33", `${run.status === "denied" ? "Denied by the policy gate" : "Rejected"}: ${why}. Nothing was paid and no order was placed (expected outcome, exit 0).`));
  }
  if (flags.has("--json")) console.log(JSON.stringify(run, null, 2));
  // A denial or human rejection is the mandate working as designed, not a crash: exit 0. Only a failed run is an error.
  process.exit(run.status === "failed" ? 1 : 0);
}

function printStep(r: AgentRun, name: string) {
  const i = r.steps.findIndex((s) => s.name === name);
  const s = r.steps[i]!;
  const d = (s.detail ?? {}) as StepDetail;
  const mode = d.mode ? c(MODE_COLOR[d.mode] ?? "7", ` ${d.mode.toUpperCase()} `) : "";
  console.log(`${ICON[s.status] ?? s.status} ${i + 1}. ${c("1", d.title)} ${c("90", `[${d.tool}]`)} ${mode}`);
  if (d.summary) console.log(`      ${d.summary}`);
  if (d.error) console.log(c("31", `      ${d.error}`));
  for (const [k, v] of Object.entries(d.ids ?? {})) console.log(c("90", `      ${k}: `) + v);
  for (const l of d.links ?? []) console.log(c("90", `      ${l.label}: `) + c("4", l.url));
  for (const f of d.facts ?? []) console.log(c(f.holds ? "32" : "90", `      ${f.holds ? "✓" : "✕"} ${f.label}`));
  if (d.secret) console.log(c("90", `      ${d.secret.label}: `) + `${d.secret.value.slice(0, 3)}•••••• (masked; --json to reveal)`);
}

main().catch((e) => {
  // Expected setup problems (e.g. the zingo Docker preflight) get one clear line, not a stack trace.
  if (e instanceof Error && e.name === "WalletError") console.error(c("31", `error: ${e.message}`));
  else console.error(e);
  process.exit(1);
});
