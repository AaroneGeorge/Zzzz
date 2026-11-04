// ZEC -> USDC (Base) bridge leg via NEAR Intents 1Click. QUOTE ONLY: we never request a non-dry quote,
// so no deposit address exists and nothing can be funded by mistake.
//   ONECLICK_MODE=dry (default)  -> live dry quote from 1click.chaindefuser.com (real prices, no funds)
//   ONECLICK_MODE=offline        -> recorded fixture (see mock.ts)
// A failed live call degrades to the fixture with `mode:"fixture"` + `fallbackReason` — never silently.
import type { BridgeQuote } from "../types";
import { mockBridgeQuote } from "./mock";
import {
  BITREFILL_X402_PAYTO_BASE,
  isEvmAddr,
  isMainnetZecRefundAddr,
  PLACEHOLDER_REFUND_T_ADDR,
  requestDryQuote,
  type FetchLike,
} from "./oneclick";

export * from "./oneclick";
export { mockBridgeQuote } from "./mock";

export type BridgeMode = "dry" | "offline";

export type BridgeQuoteResult = BridgeQuote & {
  /** "quote" = live 1Click dry quote (real market price, unfunded); "fixture" = recorded, no network. */
  mode: "quote" | "fixture";
  amountInUsd?: string;
  minAmountInZec?: string;
  amountInZat?: number;
  timeEstimateSec?: number;
  refundTo: string;
  recipient: string;
  refundToIsPlaceholder: boolean;
  recipientIsPlaceholder: boolean;
  signature?: string;
  quotedAt: string;
  notes: string[];
  fallbackReason?: string;
};

export interface BridgeOpts {
  mode?: BridgeMode;
  fetch?: FetchLike;
  jwt?: string;
  slippageBps?: number;
}

export async function getBridgeQuote(
  zecAddrRefund: string | undefined,
  usdcRecipient: string | undefined,
  usdAmount: number,
  opts: BridgeOpts = {},
): Promise<BridgeQuoteResult> {
  if (!(usdAmount > 0)) throw new Error(`usdAmount must be > 0 (got ${usdAmount})`);
  const mode: BridgeMode = opts.mode ?? (process.env.ONECLICK_MODE === "offline" ? "offline" : "dry");
  const notes: string[] = ["1Click dry quote: no deposit address issued, no funds moved."];

  // 1Click is mainnet-only; our wallet is testnet. Substitute an unspendable placeholder for the dry quote.
  const refundOk = isMainnetZecRefundAddr(zecAddrRefund);
  const refundTo = refundOk ? zecAddrRefund! : PLACEHOLDER_REFUND_T_ADDR;
  if (!refundOk) notes.push(`refundTo placeholder ${PLACEHOLDER_REFUND_T_ADDR} (1Click needs a mainnet t-address; got ${zecAddrRefund ? "a non-mainnet/shielded address" : "none"}).`);
  const recipientOk = isEvmAddr(usdcRecipient);
  const recipient = recipientOk ? usdcRecipient! : BITREFILL_X402_PAYTO_BASE;
  if (!recipientOk) notes.push(`recipient placeholder ${BITREFILL_X402_PAYTO_BASE} (Bitrefill's x402 Base pay-to; no usdc_base invoice address given).`);

  if (mode === "offline") return mockBridgeQuote(usdAmount, { refundTo, recipient, refundOk, recipientOk, notes });

  try {
    const r = await requestDryQuote({ refundTo, recipient, usdAmount, jwt: opts.jwt ?? (process.env.ONECLICK_JWT || undefined), slippageBps: opts.slippageBps, fetch: opts.fetch });
    const q = r.quote;
    return {
      kind: "dry",
      provider: "near-intents-1click",
      mode: "quote",
      amountInZec: q.amountInFormatted,
      amountOutUsdc: q.amountOutFormatted,
      amountInUsd: q.amountInUsd,
      minAmountInZec: q.minAmountIn ? (Number(q.minAmountIn) / 1e8).toFixed(8) : undefined,
      amountInZat: Number(q.amountIn),
      depositAddress: q.depositAddress, // always undefined for dry quotes
      quoteId: r.correlationId,
      expiresAt: q.deadline ?? String(r.quoteRequest?.deadline ?? ""),
      timeEstimateSec: q.timeEstimate,
      refundTo,
      recipient,
      refundToIsPlaceholder: !refundOk,
      recipientIsPlaceholder: !recipientOk,
      signature: r.signature,
      quotedAt: r.timestamp ?? new Date().toISOString(),
      notes,
    };
  } catch (e) {
    const q = mockBridgeQuote(usdAmount, { refundTo, recipient, refundOk, recipientOk, notes });
    q.fallbackReason = `live 1Click dry quote failed: ${(e as Error).message}`;
    return q;
  }
}
