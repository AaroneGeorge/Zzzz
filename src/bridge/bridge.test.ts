// Offline unit tests for the 1Click dry-quote bridge (fake fetch only).
import { describe, expect, test } from "bun:test";
import { BITREFILL_X402_PAYTO_BASE, getBridgeQuote, isEvmAddr, isMainnetZecRefundAddr, PLACEHOLDER_REFUND_T_ADDR, USDC_BASE, ZEC_NATIVE, type FetchLike } from "./index";
import { RECORDED_DRY_QUOTE } from "./mock";

function fake(handler: (body: any) => Response): FetchLike & { bodies: any[] } {
  const bodies: any[] = [];
  const f = (async (_u: any, init: RequestInit = {}) => {
    const b = JSON.parse(String(init.body));
    bodies.push(b);
    return handler(b);
  }) as FetchLike & { bodies: any[] };
  f.bodies = bodies;
  return f;
}
const recorded = () => new Response(JSON.stringify(RECORDED_DRY_QUOTE.response), { status: 201, headers: { "content-type": "application/json" } });

describe("address validators", () => {
  test("mainnet t-addr vs testnet / EVM", () => {
    expect(isMainnetZecRefundAddr(PLACEHOLDER_REFUND_T_ADDR)).toBe(true);
    expect(isMainnetZecRefundAddr("tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma")).toBe(false);
    expect(isMainnetZecRefundAddr("utest1abc")).toBe(false);
    expect(isEvmAddr(BITREFILL_X402_PAYTO_BASE)).toBe(true);
    expect(isEvmAddr("0x123")).toBe(false);
  });
});

describe("getBridgeQuote", () => {
  test("sends a schema-correct DRY EXACT_OUTPUT quote and maps the response", async () => {
    const f = fake(recorded);
    const q = await getBridgeQuote("utest1shieldedtestnetaddr", "0x1111111111111111111111111111111111111111", 3, { fetch: f, mode: "dry" });
    const b = f.bodies[0];
    expect(b).toMatchObject({
      dry: true,
      swapType: "EXACT_OUTPUT",
      originAsset: ZEC_NATIVE,
      destinationAsset: USDC_BASE,
      amount: "3000000",
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      refundTo: PLACEHOLDER_REFUND_T_ADDR, // testnet/shielded address replaced for the mainnet-only API
      recipient: "0x1111111111111111111111111111111111111111",
    });
    expect(Date.parse(b.deadline)).toBeGreaterThan(Date.now());
    expect(q).toMatchObject({ kind: "dry", provider: "near-intents-1click", mode: "quote", amountOutUsdc: "3.0", refundToIsPlaceholder: true, recipientIsPlaceholder: false });
    expect(Number(q.amountInZec)).toBeGreaterThan(0);
    expect(q.depositAddress).toBeUndefined();
  });
  test("API failure degrades to a labelled fixture, never silently", async () => {
    const f = fake(() => new Response(JSON.stringify({ message: "recipient is not valid" }), { status: 400 }));
    const q = await getBridgeQuote(undefined, undefined, 2, { fetch: f, mode: "dry" });
    expect(q.mode).toBe("fixture");
    expect(q.fallbackReason).toContain("recipient is not valid");
    expect(q.amountOutUsdc).toBe("2");
  });
  test("offline mode makes no request and scales the recorded quote", async () => {
    const f = fake(recorded);
    const q = await getBridgeQuote(PLACEHOLDER_REFUND_T_ADDR, BITREFILL_X402_PAYTO_BASE, 6, { fetch: f, mode: "offline" });
    expect(f.bodies.length).toBe(0);
    expect(q.mode).toBe("fixture");
    const rec = RECORDED_DRY_QUOTE.response.quote;
    expect(Number(q.amountInZec)).toBeCloseTo(Number(rec.amountInFormatted) * 2, 6);
  });
  test("rejects non-positive amounts", async () => {
    await expect(getBridgeQuote(undefined, undefined, 0, { mode: "offline" })).rejects.toThrow();
  });
});
