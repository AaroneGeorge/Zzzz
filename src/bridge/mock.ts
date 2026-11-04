// Offline bridge quote: scales the REAL recorded 1Click dry quote (fixtures/*.json) to the requested amount.
// Always labelled mode:"fixture".
import recorded from "./fixtures/dry-quote-zec-usdc-base-3usd.json";
import type { BridgeQuoteResult } from "./index";

export const RECORDED_DRY_QUOTE = recorded;

export function mockBridgeQuote(
  usdAmount: number,
  ctx: { refundTo: string; recipient: string; refundOk: boolean; recipientOk: boolean; notes?: string[] },
): BridgeQuoteResult {
  const q = recorded.response.quote;
  const recordedUsdc = Number(q.amountOutFormatted);
  const zecPerUsdc = Number(q.amountInFormatted) / recordedUsdc; // includes recorded fees + slippage
  const zec = usdAmount * zecPerUsdc;
  return {
    kind: "dry",
    provider: "near-intents-1click",
    mode: "fixture",
    amountInZec: zec.toFixed(8),
    amountOutUsdc: usdAmount.toFixed(6).replace(/\.?0+$/, ""),
    amountInUsd: (usdAmount * (Number(q.amountInUsd) / recordedUsdc)).toFixed(4),
    amountInZat: Math.round(zec * 1e8),
    quoteId: `fixture-${recorded.response.correlationId}`,
    timeEstimateSec: q.timeEstimate,
    refundTo: ctx.refundTo,
    recipient: ctx.recipient,
    refundToIsPlaceholder: !ctx.refundOk,
    recipientIsPlaceholder: !ctx.recipientOk,
    quotedAt: recorded.recordedAt,
    notes: [...(ctx.notes ?? []), `FIXTURE: scaled from a real 1Click dry quote recorded ${recorded.recordedAt}.`],
  };
}
