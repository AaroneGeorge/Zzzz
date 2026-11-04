import { describe, expect, test } from "bun:test";
import { findPayment, memoMatches, MockGateway, SourceGateway, testnetPriceZat, toGatewayNote, waitForPayment, GatewayTimeout, type GatewayInvoice, type GatewayNote } from "./index";

const inv: GatewayInvoice = { id: "zrg-abc-123456", address: "utest1gw", amountZat: 300_000, memo: "ZR1|zrg-abc-123456|deadbeef", network: "testnet", createdAt: "", pricing: "t" };
const note = (o: Partial<GatewayNote>): GatewayNote => ({ txid: "a".repeat(64), memo: inv.memo, valueZat: 300_000, mined: true, height: 4_582_300, ...o });

describe("gateway matcher", () => {
  test("memo match: exact invoice id, any policy hash, trailing NULs ok", () => {
    expect(memoMatches("ZR1|zrg-abc-123456|deadbeef", inv.id)).toBe(true);
    expect(memoMatches("ZR1|zrg-abc-123456|0123abcd\0\0\0", inv.id)).toBe(true);
    expect(memoMatches("ZR1|zrg-abc-1234567|deadbeef", inv.id)).toBe(false);
    expect(memoMatches("hello zrg-abc-123456", inv.id)).toBe(false);
  });
  test("amount match: ≥ expected passes, underpayment fails, split outputs of one tx are summed", () => {
    expect(findPayment([note({ valueZat: 300_000 })], { invoiceId: inv.id, minZat: 300_000 })?.height).toBe(4_582_300);
    expect(findPayment([note({ valueZat: 400_000 })], { invoiceId: inv.id, minZat: 300_000 })).not.toBeNull();
    expect(findPayment([note({ valueZat: 299_999 })], { invoiceId: inv.id, minZat: 300_000 })).toBeNull();
    expect(findPayment([note({ valueZat: 200_000 }), note({ valueZat: 100_000 })], { invoiceId: inv.id, minZat: 300_000 })?.valueZat).toBe(300_000);
  });
  test("wrong memo is ignored even with enough value; mempool note needs mining", () => {
    expect(findPayment([note({ memo: "ZR1|zrg-other-000000|deadbeef", valueZat: 9e6 })], { invoiceId: inv.id, minZat: 1 })).toBeNull();
    expect(findPayment([note({ mined: false, height: undefined })], { invoiceId: inv.id, minZat: 1 })).toBeNull();
    expect(findPayment([note({ mined: false, height: undefined })], { invoiceId: inv.id, minZat: 1, requireMined: false })).not.toBeNull();
  });
  test("zingo note parsing", () => {
    expect(toGatewayNote({ txid: "t", value: 5, status: "confirmed at height 4582300", memo: "m\0\0" })).toEqual({ txid: "t", memo: "m", valueZat: 5, height: 4582300, mined: true });
    expect(toGatewayNote({ txid: "t", value: 5, status: "pending (mempool)" })!.mined).toBe(false);
  });
});

describe("gateway watcher", () => {
  test("polls until the payment is mined, reports mempool progress", async () => {
    let polls = 0;
    const src = { listNotes: async () => (++polls < 3 ? (polls === 2 ? [note({ mined: false, height: undefined })] : []) : [note({})]) };
    const progress: unknown[] = [];
    const v = await waitForPayment(src, "ufvk", inv, { timeoutMs: 10_000, pollMs: 1, onProgress: (p) => progress.push(p) });
    expect(v).toMatchObject({ verified: true, txid: "a".repeat(64), height: 4_582_300, amountZat: 300_000, view: "ufvk", polls: 3 });
    expect(JSON.stringify(progress)).toContain("inMempool");
  });
  test("timeout: wrong memo never verifies", async () => {
    let t = 0;
    const src = { listNotes: async () => [note({ memo: "ZR1|zrg-nope-000000|deadbeef" })] };
    const p = waitForPayment(src, "ufvk", inv, { timeoutMs: 100, pollMs: 30, sleep: async () => {}, now: () => (t += 30) });
    await expect(p).rejects.toBeInstanceOf(GatewayTimeout);
  });
  test("source errors are retried, then time out with the last error", async () => {
    let t = 0;
    const src = { listNotes: async (): Promise<GatewayNote[]> => { throw new Error("lightwalletd down"); } };
    await expect(waitForPayment(src, "wallet", inv, { timeoutMs: 100, pollMs: 30, sleep: async () => {}, now: () => (t += 30) })).rejects.toThrow("lightwalletd down");
  });
  test("SourceGateway issues invoices with the memo; MockGateway sees only sends to its address", async () => {
    const gw = new SourceGateway("ufvk", "utest1gw", { listNotes: async () => [] }, { timeoutMs: 10, pollMs: 1, requireMined: true });
    const i = gw.createInvoice({ runTag: "x1", amountZat: 100_000, memoFor: (id) => `ZR1|${id}|cafebabe`, pricing: "p" });
    expect(i.memo).toBe(`ZR1|${i.id}|cafebabe`);
    const m = new MockGateway();
    const mi = m.createInvoice({ runTag: "x2", amountZat: 100_000, memoFor: (id) => `ZR1|${id}|cafebabe`, pricing: "p" });
    await expect(m.waitForPayment(mi, { sent: { txid: "t", amountZat: 100_000, memo: mi.memo, to: m.address } })).resolves.toMatchObject({ view: "mock" });
    const mi2 = m.createInvoice({ runTag: "x3", amountZat: 100_000, memoFor: (id) => `ZR1|${id}|cafebabe`, pricing: "p" });
    await expect(m.waitForPayment(mi2, { timeoutMs: 30, sent: { txid: "t2", amountZat: 100_000, memo: mi2.memo, to: "utest1elsewhere" } })).rejects.toBeInstanceOf(GatewayTimeout);
  });
});

describe("testnet price", () => {
  test("quoted ZEC × scale (default 1), rounded to 1,000 zat, clamped to 0.001–0.01 TAZ", () => {
    expect(testnetPriceZat("0.00225482", {}).amountZat).toBe(225_000);
    expect(testnetPriceZat("0.0331", { GATEWAY_TESTNET_SCALE: "0.1" }).amountZat).toBe(331_000);
    expect(testnetPriceZat("5", {}).amountZat).toBe(1_000_000);
    expect(testnetPriceZat("0.0001", {}).amountZat).toBe(100_000);
    expect(testnetPriceZat(undefined, {}).amountZat).toBe(100_000);
    expect(testnetPriceZat("0.0331", {}).pricing).toContain("testnet stand-in");
  });
});
