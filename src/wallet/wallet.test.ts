import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallet, ManualWallet, MockWallet, ZecliWallet, ZingoWallet } from "./index";
import type { CommandRunner, RunOptions } from "./types";
import { formatMemo, parseJsonOutput, parseMemo, zatToZec, zecToZat } from "./util";

const TXID = "22a9c727bf2a375772cd488a2b4470fbec454651e047088dbe3382136be50531";
const ADDR = "utest1fwm0cc2hugw4vuvfxdh8lm9m4ncq7ppgcnem98062ka8gtuuc5jyhemud5mtc6n8whflxldzg8tn66mc86nktgm33fkvt8djus4urx96";
const noSleep = async () => {};

/** Fake CLI: maps a predicate on argv to stdout; records every call. */
function fakeRunner(routes: Array<[(argv: string[]) => boolean, string | (() => string), number?]>) {
  const calls: Array<{ argv: string[]; opts?: RunOptions }> = [];
  const runner: CommandRunner = async (argv, opts) => {
    calls.push({ argv, opts });
    for (const [match, out, code] of routes) {
      if (match(argv)) return { code: code ?? 0, stdout: typeof out === "function" ? out() : out, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected argv ${argv.join(" ")}` };
  };
  return { runner, calls };
}
const has = (w: string) => (argv: string[]) => argv.includes(w);

describe("util", () => {
  test("zat <-> zec is exact", () => {
    expect(zatToZec(100_000)).toBe("0.00100000");
    expect(zatToZec(123_456_789)).toBe("1.23456789");
    expect(zecToZat("0.001")).toBe(100_000);
    expect(zecToZat("1.23456789")).toBe(123_456_789);
    expect(() => zatToZec(-1)).toThrow();
    expect(() => zecToZat("1.123456789")).toThrow();
  });
  test("memo format round-trips", () => {
    const m = formatMemo("inv_abc123", "deadbeefcafebabe");
    expect(m).toBe("ZR1|inv_abc123|deadbeef");
    expect(parseMemo(m)).toEqual({ invoiceId: "inv_abc123", hash8: "deadbeef" });
    expect(parseMemo("hello")).toBeNull();
  });
  test("parseJsonOutput skips banners", () => {
    expect(parseJsonOutput<{ a: number }>('Launching save task...\n{\n  "a": 1\n}\nSave task shutdown')).toEqual({ a: 1 });
    expect(parseJsonOutput<number[]>("noise\n[1,2]")).toEqual([1, 2]);
  });
});

describe("MockWallet", () => {
  test("self-send shows memo, mode=mock, fake txid", async () => {
    const w = new MockWallet({ balanceZat: 1_000_000 });
    const addr = await w.getAddress();
    const s = await w.send(addr, 100_000, "ZR1|inv1|abcdef12");
    expect(s.mode).toBe("mock");
    expect(s.txid.startsWith("mock-")).toBe(true);
    expect(s.explorerUrl.startsWith("mock://")).toBe(true);
    expect(s.confirmed).toBe(false);
    expect(await w.waitConfirmed(s.txid, 1000)).toBe(true);
    expect(await w.readMemos()).toEqual([{ txid: s.txid, memo: "ZR1|inv1|abcdef12", amountZat: 100_000 }]);
    expect((await w.getBalance()).spendableZat).toBe(1_000_000 - 10_000);
  });
  test("rejects bad input and overspend", async () => {
    const w = new MockWallet({ balanceZat: 50_000 });
    await expect(w.send(ADDR, 100_000, "x")).rejects.toThrow(/insufficient/);
    await expect(w.send(ADDR, 0, "x")).rejects.toThrow(/amountZat/);
    await expect(w.send(ADDR, 1, "x".repeat(513))).rejects.toThrow(/512/);
  });
});

describe("ManualWallet", () => {
  const explorerHtml = (c: number) => `<html><dt>Confirmations</dt><dd>${c}</dd></html>`;
  test("without override send() explains what the human must do", async () => {
    const w = new ManualWallet({ txid: "", fetchImpl: (async () => new Response("")) as any });
    await expect(w.send(ADDR, 100_000, "ZR1|inv|12345678")).rejects.toThrow(/WALLET_TXID_OVERRIDE/);
  });
  test("returns override txid labelled manual, checks explorer", async () => {
    let n = 0;
    const fetchImpl = (async () => new Response(explorerHtml(n++ < 1 ? 0 : 3))) as any;
    const w = new ManualWallet({ txid: TXID, fetchImpl, sleepFn: noSleep, pollMs: 1 });
    const s = await w.send(ADDR, 100_000, "ZR1|inv|12345678");
    expect(s).toMatchObject({ txid: TXID, mode: "manual", network: "testnet", confirmed: false });
    expect(s.explorerUrl).toBe(`https://testnet.zcashexplorer.app/transactions/${TXID}`);
    expect(await w.waitConfirmed(TXID, 60_000)).toBe(true);
    expect(await w.readMemos()).toEqual([{ txid: TXID, memo: "ZR1|inv|12345678" }]);
  });
  test("rejects a malformed override", () => {
    expect(() => new ManualWallet({ txid: "nothex" })).toThrow();
  });
});

describe("ZecliWallet (fake zcli)", () => {
  test("builds testnet argv and parses address/balance/send/notes", async () => {
    const { runner, calls } = fakeRunner([
      [has("address"), JSON.stringify({ orchard: ADDR, transparent: "tmSdSue6pKaZMbVFTS6TpxaiC5oV4QkodxT" })],
      [has("sync"), 'cached FVK\n{"notes_found":1}'],
      [has("balance"), JSON.stringify({ transparent: 0, shielded: 100_000_000, total: 100_000_000 })],
      [has("send"), JSON.stringify({ txid: TXID, amount_zat: 100_000, fee_zat: 10_000, recipient: ADDR, type: "z→z", success: true, error: null })],
      [has("notes"), JSON.stringify([{ zat: 100_000, height: 4582200, txid: TXID, memo: "ZR1|inv|12345678", spent: false }, { zat: 5, height: 1, spent: false }])],
      [has("history"), JSON.stringify([{ direction: "sent", txid: TXID, height: 4582200, zat: 100_000 }])],
    ]);
    const w = new ZecliWallet({ runner, bin: "zcli-0.6.0", identity: "/k", sleepFn: noSleep });
    expect(await w.getAddress()).toBe(ADDR);
    expect(calls[0]!.argv).toEqual(["zcli-0.6.0", "--json", "--testnet", "-i", "/k", "address"]);
    expect(await w.getBalance()).toEqual({ spendableZat: 100_000_000 });
    const s = await w.send(ADDR, 100_000, "ZR1|inv|12345678");
    expect(s).toMatchObject({ txid: TXID, mode: "zecli", amountZat: 100_000, memo: "ZR1|inv|12345678" });
    const sendCall = calls.find((c) => c.argv.includes("send"))!;
    expect(sendCall.argv.slice(-4)).toEqual(["0.00100000", ADDR, "--memo", "ZR1|inv|12345678"]);
    expect(await w.waitConfirmed(TXID, 1000)).toBe(true);
    expect(await w.readMemos()).toEqual([{ txid: TXID, memo: "ZR1|inv|12345678", amountZat: 100_000, height: 4582200 }]);
  });
  test("surfaces zcli {error} JSON", async () => {
    const { runner } = fakeRunner([[has("sync"), '{"error":"header proof fetch failed: GetHeaderProof removed"}', 0]]);
    const w = new ZecliWallet({ runner, identity: "/k" });
    await expect(w.getBalance()).rejects.toThrow(/GetHeaderProof/);
  });
  test("mnemonic goes via env, never argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zr-"));
    const f = join(dir, "m.txt");
    writeFileSync(f, "abandon ability able\n");
    const { runner, calls } = fakeRunner([[has("address"), JSON.stringify({ orchard: ADDR })]]);
    const w = new ZecliWallet({ runner, mnemonicFile: f });
    await w.getAddress();
    expect(calls[0]!.argv.join(" ")).not.toContain("abandon");
    expect(calls[0]!.argv).not.toContain("-i");
    expect(calls[0]!.opts?.env?.ZCLI_MNEMONIC).toBe("abandon ability able");
    expect(calls[0]!.opts?.env?.ZCLI_JSON).toBe("true"); // clap bool: "1" is rejected
  });
  test("v10 grammar refuses testnet", () => {
    expect(() => new ZecliWallet({ grammar: "v10", network: "testnet" })).toThrow(/mainnet-only/);
  });
});

describe("createWallet", () => {
  test("picks backend from ZEC_WALLET", () => {
    expect(createWallet("mock")).toBeInstanceOf(MockWallet);
    expect(createWallet("manual")).toBeInstanceOf(ManualWallet);
    expect(createWallet("zecli")).toBeInstanceOf(ZecliWallet);
    expect(createWallet("zingo")).toBeInstanceOf(ZingoWallet);
    expect(createWallet(undefined).mode).toBe(process.env.ZEC_WALLET ? (process.env.ZEC_WALLET as any) : "mock");
    expect(() => createWallet("bogus")).toThrow(/unknown/);
  });
});
