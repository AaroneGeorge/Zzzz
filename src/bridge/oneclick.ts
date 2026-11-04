// NEAR Intents 1Click API — dry quotes only (no deposit address is issued, nothing can be funded).
// Schema verified against https://1click.chaindefuser.com/docs/v0/openapi.yaml and live calls on 2026-11-04:
//  - native ZEC asset id is `nep141:zec.omft.near` (NOT "zec:ZEC"); USDC on Base is
//    `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` (GET /v0/tokens)
//  - required: dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount (base units,
//    integer string), refundTo, refundType, recipient, recipientType, deadline
//  - refundTo must be a MAINNET ZEC address (t1…): testnet tm… and junk -> 400 "refundTo is not valid"
//  - recipient 0x…dEaD is rejected ("recipient is not valid"); a normal Base EOA works
//  - dry response omits depositAddress / deadline / timeWhenInactive and has no quote id; returns 201
export const ONECLICK_BASE = "https://1click.chaindefuser.com";
export const ZEC_NATIVE = "nep141:zec.omft.near";
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** Valid-checksum mainnet t-address with an all-zero pubkey hash (unspendable). Only ever used for DRY quotes. */
export const PLACEHOLDER_REFUND_T_ADDR = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
/** Bitrefill's published x402 pay-to address on Base (docs.cdp.coinbase.com Bitrefill plugin). Placeholder recipient for dry quotes. */
export const BITREFILL_X402_PAYTO_BASE = "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OneClickQuoteResponse {
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    timeEstimate?: number;
    depositAddress?: string;
    deadline?: string;
    refundFee?: string;
    withdrawFee?: string;
  };
  quoteRequest: Record<string, unknown>;
  signature?: string;
  timestamp?: string;
  correlationId?: string;
}

export class OneClickError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
    this.name = "OneClickError";
  }
}

export function isMainnetZecRefundAddr(a?: string): boolean {
  return !!a && /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
}
export function isUnifiedMainnetAddr(a?: string): boolean {
  return !!a && /^u1[02-9ac-hj-np-z]{100,}$/.test(a);
}
export function isEvmAddr(a?: string): boolean {
  return !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
}

export interface DryQuoteParams {
  refundTo: string;
  recipient: string;
  usdAmount: number;
  slippageBps?: number;
  jwt?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

/** EXACT_OUTPUT: "how much ZEC do I need so the recipient gets exactly `usdAmount` USDC on Base?" */
export async function requestDryQuote(p: DryQuoteParams): Promise<OneClickQuoteResponse> {
  const f = p.fetch ?? fetch;
  const body = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: p.slippageBps ?? 100,
    originAsset: ZEC_NATIVE,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_BASE,
    amount: String(Math.round(p.usdAmount * 1e6)), // USDC has 6 decimals
    refundTo: p.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
  const r = await f(`${p.baseUrl ?? ONECLICK_BASE}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(p.jwt ? { authorization: `Bearer ${p.jwt}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
  });
  const text = await r.text();
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    j = { message: text.slice(0, 300) };
  }
  if (!r.ok || !j?.quote) throw new OneClickError(`1Click quote ${r.status}: ${j?.message ?? "no quote"}`, r.status, j);
  return j as OneClickQuoteResponse;
}
