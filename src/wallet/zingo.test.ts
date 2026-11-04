import { describe, expect, test } from "bun:test";
import { flattenNotes, isSynced, takeJson, ZingoWallet, type ReplSpawner } from "./zingo";

const TXID = "a22ea50b38362055befe1089d7f7d7d5203eba2f3efc61010934af7fe91e92ab";
const ADDR = "utest1fwm0cc2hugw4vuvfxdh8lm9m4ncq7ppgcnem98062ka8gtuuc5jyhemud5mtc6n8whflxldzg8tn66mc86nktgm33fkvt8djus4urx96";
const pretty = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Fake interactive zingo-cli: answers each stdin line from a handler; records lines and argv. */
function fakeZingo(handler: (line: string, n: number) => string | { err: string }) {
  const lines: string[] = [];
  const argvs: string[][] = [];
  let syncCalls = 0;
  const spawner: ReplSpawner = (argv, onOut, onErr) => {
    argvs.push(argv);
    let done!: (c: number) => void;
    const exited = new Promise<number>((r) => (done = r));
    setTimeout(() => onErr("WARNING: nakednet\n"), 0);
    setTimeout(() => onOut("Launching sync task...\nLaunching save task...\n"), 0);
    return {
      write(line) {
        const l = line.trim();
        lines.push(l);
        if (l === "quit") return void setTimeout(() => { onOut("Save task shutdown successfully.\n"); done(0); }, 0);
        const n = l === "sync status" ? syncCalls++ : 0;
        const r = handler(l, n);
        setTimeout(() => (typeof r === "string" ? onOut(r) : onErr(r.err + "\n")), 1);
      },
      kill: () => done(137),
      exited,
    };
  };
  return { spawner, lines, argvs };
}

const notSynced = pretty({ scan_ranges: [{ priority: "Scanned", start_block: "4581000", end_block: "4582100" }], sync_start_height: 0 });
const synced = pretty({ scan_ranges: [{ priority: "Scanned", start_block: "4581000", end_block: "4582150" }], sync_start_height: 4582149 });
const notesAll = pretty({
  ironwood_notes: { note_summaries: [
    { value: 100000000, status: "confirmed at block height 4582114", spend_status: "confirmed spent in " + TXID, memo: "fauzec/v1\nX", txid: "22a9c727bf2a375772cd488a2b4470fbec454651e047088dbe3382136be50531" },
    { value: 99980000, status: "confirmed at block height 4582144", spend_status: "unspent", memo: null, txid: TXID },
    { value: 10000, status: "confirmed at block height 4582144", spend_status: "unspent", memo: "ZR1|selftest-1840|7622af6e", txid: TXID },
  ] },
  orchard_notes: { note_summaries: [] },
  sapling_notes: { note_summaries: [] },
});

describe("zingo helpers", () => {
  test("takeJson skips banners and non-JSON brackets, waits for completion", () => {
    expect(takeJson("Launching...\n[\n    confirmed_ironwood_balance: 1\n]\n{\n  \"a\": \"}\"\n}\nrest")).toEqual([{ a: "}" }, "\nrest"]);
    expect(takeJson("{\n  \"a\": [1, 2")).toBeNull();
    expect(takeJson("no json here")).toBeNull();
  });
  test("isSynced needs a session tip and all ranges scanned", () => {
    expect(isSynced(JSON.parse(notSynced))).toBe(false);
    expect(isSynced(JSON.parse(synced))).toBe(true);
    expect(isSynced({ scan_ranges: [{ priority: "Historic", end_block: 9 }], sync_start_height: 5 })).toBe(false);
  });
  test("flattenNotes handles the pool/note_summaries shape", () => {
    expect(flattenNotes(JSON.parse(notesAll)).length).toBe(3);
  });
});

describe("ZingoWallet (fake zingo-cli REPL)", () => {
  test("address uses --nosync session", async () => {
    const f = fakeZingo((l) => (l === "addresses" ? pretty([{ account: 0, has_orchard: true, encoded_address: ADDR }]) : "?"));
    const w = new ZingoWallet({ cmd: ["zingo"], spawner: f.spawner });
    expect(await w.getAddress()).toBe(ADDR);
    expect(f.argvs[0]).toEqual(["zingo", "--nosync"]);
    expect(f.lines).toEqual(["addresses", "quit"]);
  });

  test("balance waits for sync, send quotes memo and returns mode zingo", async () => {
    const f = fakeZingo((l, n) => {
      if (l === "sync status") return n < 2 ? notSynced : synced;
      if (l === "spendable_balance") return pretty({ spendable_balance: 99980000 });
      if (l.startsWith("quicksend")) return pretty({ txids: [TXID], transmissions: [{ txid: TXID, over_mixnet: false }] });
      return "?";
    });
    const w = new ZingoWallet({ cmd: ["zingo"], spawner: f.spawner, sleepFn: async () => {} });
    expect(await w.getBalance()).toEqual({ spendableZat: 99980000 });
    const s = await w.send(ADDR, 10000, "ZR1|selftest-1840|7622af6e");
    expect(s).toMatchObject({ txid: TXID, mode: "zingo", network: "testnet", amountZat: 10000, confirmed: false });
    expect(s.explorerUrl).toBe(`https://testnet.zcashexplorer.app/transactions/${TXID}`);
    expect(f.lines).toContain(`quicksend ${ADDR} 10000 "ZR1|selftest-1840|7622af6e"`);
    expect(f.lines.filter((l) => l === "quit").length).toBe(2);
  });

  test("CLI error line rejects the send", async () => {
    const f = fakeZingo((l) => (l === "sync status" ? synced : { err: "Error: insufficient balance" }));
    const w = new ZingoWallet({ cmd: ["zingo"], spawner: f.spawner });
    await expect(w.send(ADDR, 10000, "ZR1|x|12345678")).rejects.toThrow(/insufficient balance/);
  });

  test("rejects memos that would break REPL quoting", async () => {
    const w = new ZingoWallet({ cmd: ["zingo"], spawner: fakeZingo(() => "").spawner });
    await expect(w.send(ADDR, 1, 'a"b')).rejects.toThrow(/quotes/);
  });

  test("readMemos decrypts from notes; waitConfirmed uses explorer", async () => {
    const f = fakeZingo((l) => (l === "sync status" ? synced : l === "notes all" ? notesAll : "?"));
    let calls = 0;
    const fetchImpl = (async () => new Response(`<dt>Confirmations</dt><dd>${calls++ ? 2 : 0}</dd>`)) as any;
    const w = new ZingoWallet({ cmd: ["zingo"], spawner: f.spawner, fetchImpl, sleepFn: async () => {}, pollMs: 1 });
    const memos = await w.readMemos();
    expect(memos.find((m) => m.txid === TXID)).toEqual({ txid: TXID, memo: "ZR1|selftest-1840|7622af6e", amountZat: 10000, height: 4582144 });
    expect(memos.length).toBe(2);
    expect(await w.waitConfirmed(TXID, 60_000)).toBe(true);
  });
});

describe("zingo preflight (ZEC_WALLET=zingo)", () => {
  const { zingoPreflight } = require("./zingo") as typeof import("./zingo");
  test("Docker unreachable: fails with a clear message, tries docker then sudo -n docker", async () => {
    const calls: string[] = [];
    const run = async (argv: string[]) => (calls.push(argv.join(" ")), { code: 1, out: "Cannot connect to the Docker daemon" });
    await expect(zingoPreflight({ env: {}, run })).rejects.toThrow(/Docker is not reachable.*docker build -f docker\/zingo.Dockerfile/);
    expect(calls.map((c) => c.split(" version")[0])).toEqual(["docker", "sudo -n docker"]);
  });
  test("image missing: tells you to build it", async () => {
    const run = async (argv: string[]) => (argv.includes("image") ? { code: 1, out: "Error: No such image" } : { code: 0, out: "27.0" });
    await expect(zingoPreflight({ env: {}, run })).rejects.toThrow(/image zecrecharge\/zingo-cli not found.*ZEC_WALLET=mock/);
  });
  test("a hung docker call is cut by the timeout (real runner)", async () => {
    const { bunPreflightRunner } = require("./zingo") as typeof import("./zingo");
    const t0 = Date.now();
    const r = await bunPreflightRunner(["sleep", "30"], 300);
    expect(r.code).toBe(-1);
    expect(Date.now() - t0).toBeLessThan(3000);
    const hung = async () => ({ code: -1, out: "timed out after 300 ms" });
    await expect(zingoPreflight({ env: {}, run: hung, timeoutMs: 300 })).rejects.toThrow(/not reachable within 0.3 s/);
  });
  test("a missing docker binary is reported, not thrown raw", async () => {
    await expect(zingoPreflight({ env: { DOCKER: "/nonexistent/docker-zr" }, timeoutMs: 1000 })).rejects.toThrow(/Docker is not reachable/);
  });
  test("ok when Docker answers and the image exists", async () => {
    const run = async () => ({ code: 0, out: "ok" });
    expect(await zingoPreflight({ env: { DOCKER: "docker" }, run })).toEqual({ docker: "docker", image: "zecrecharge/zingo-cli" });
  });
});
