// CLI behaviour that judges see first: usage errors, India-only, missing key, denied exit code.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROMPT, nonIndianReason, promptFromArgs } from "./agent/parse";

const CLI = join(import.meta.dir, "cli.ts");
function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const ledger = join(mkdtempSync(join(tmpdir(), "zr-cli-")), "ledger.jsonl");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ZR_USE_FAKES: "1", AGENT_MODE: "scripted", BITREFILL_MODE: "offline", ZEC_WALLET: "mock", LEDGER_PATH: ledger, NO_COLOR: "1", ...extraEnv };
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { env, stdin: "ignore" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("prompt from CLI args", () => {
  test("no argument runs the default demo request", () => {
    expect(promptFromArgs([])).toEqual({ prompt: DEFAULT_PROMPT });
    expect(promptFromArgs(["--yes"])).toEqual({ prompt: DEFAULT_PROMPT });
  });
  test("an empty or blank prompt is a usage error, not the default run", () => {
    expect(promptFromArgs([""])).toEqual({ error: "the request is empty" });
    expect(promptFromArgs(["   ", "--yes"])).toEqual({ error: "the request is empty" });
  });
  test("CLI: empty prompt prints usage, exits 2, spends nothing", () => {
    const r = cli([""]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("usage:");
    expect(r.out).not.toContain("steps OK");
  });
});

describe("India only", () => {
  test("non-Indian requests are recognised", () => {
    expect(nonIndianReason("Recharge 07700900123 with £10 Vodafone UK")).toContain("£");
    expect(nonIndianReason("$20 Amazon gift card")).toContain("$");
    expect(nonIndianReason("Recharge +44 7700 900123 with 10 GBP")).not.toBeNull();
    expect(nonIndianReason("Recharge +447700900123 Vodafone")).toContain("+44");
    expect(nonIndianReason("Recharge +919999999999 with ₹239 Jio")).toBeNull();
    expect(nonIndianReason("₹700 Amazon Pay gift card for my mom")).toBeNull();
  });
  test("CLI: a UK request fails with 'India only (INR)'", () => {
    const r = cli(["Recharge 07700900123 with £10 Vodafone UK"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("India only (INR)");
    expect(r.out).not.toContain("+917700900123");
  });
});

describe("CLI outcomes", () => {
  test("AGENT_MODE=llm without a key: friendly message suggesting scripted mode", () => {
    const r = cli(["Recharge +919999999999 with ₹239 Jio"], { AGENT_MODE: "llm", ANTHROPIC_API_KEY: "" }); // "" so bun does not load the key from app/.env
    expect(r.code).toBe(1);
    expect(r.out).toContain("needs ANTHROPIC_API_KEY");
    expect(r.out).toContain("AGENT_MODE=scripted");
    expect(r.out).not.toContain("Could not resolve authentication");
  });
  test("a denied run exits 0 with a clear summary", () => {
    const r = cli(["₹1,500 Flipkart gift card"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DENIED");
    expect(r.out).toContain("Nothing was paid and no order was placed");
  });
  test("the default run still completes 7/7", () => {
    const r = cli([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("7/7 steps OK");
  });
});
