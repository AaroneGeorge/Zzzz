// Dependency injection for the agent. Codes only against the PLAN.md C/T1 + C/T2 interfaces.
// The real modules (src/wallet, src/bitrefill, src/bridge) are loaded dynamically; if one is
// missing or fails to construct, the in-folder fakes are used and every result says "mock"/"fixture".
import type { BridgeQuote, Invoice, Order, Product, ShieldedSend } from "../types";
import type { PolicyGate } from "../policy";
import type { AgentRun } from "./state";
import type { Gateway } from "../gateway";

export interface WalletLike {
  getAddress(): Promise<string>;
  getBalance(): Promise<{ spendableZat: number }>;
  send(to: string, amountZat: number, memo: string): Promise<ShieldedSend>;
  waitConfirmed(txid: string, timeoutMs: number): Promise<boolean>;
  readMemos(): Promise<Array<{ txid: string; memo: string }>>;
}

export interface BitrefillLike {
  ping?(): Promise<unknown>;
  searchProducts(q: string, opts: { country?: string; includeTest: boolean }): Promise<Product[]>;
  createInvoice(items: InvoiceItem[], paymentMethod: string, opts?: { autoPay?: boolean }): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice>;
  getOrder(id: string): Promise<Order>;
}

/** Item shape passed to createInvoice (same as T2's CartItem). */
export interface InvoiceItem {
  productId: string;
  packageId?: string;
  value?: number;
  quantity?: number;
  phoneNumber?: string;
}

export type BridgeFn = (zecAddrRefund: string | undefined, usdcRecipient: string | undefined, usdAmount: number) => Promise<BridgeQuote>;

export type Mode = "real" | "test" | "quote" | "fixture" | "mock" | "manual";

export interface AgentConfig {
  agentMode: "llm" | "scripted";
  model: string;
  bitrefillMode: "test" | "real" | "offline";
  walletKind: string; // zecli | zingo | manual | mock
  network: "testnet" | "mainnet";
  inrPerUsd: number;
  /** Testnet amount actually sent (the shielded leg is a testnet proof of the flow). */
  testnetSendZat: number;
  destAddress?: string;
  refundAddress?: string;
  /** USDC-on-Base recipient for the dry quote when the invoice has none; undefined = bridge's own placeholder. */
  usdcRecipientFallback?: string;
  orderPollMs: number;
  confirmWaitMs: number;
  maxLlmTurns: number;
  /** how long the gateway waits for a mined, matching payment before giving up (no order is placed) */
  gatewayTimeoutMs?: number;
}

export interface AgentDeps {
  wallet: WalletLike;
  bitrefill: BitrefillLike;
  bridge: BridgeFn;
  /** Merchant-side shielded payment gateway; defaults to an in-memory MockGateway when absent. */
  gateway?: Gateway;
  /** Same gate instance must be shared by every run in the process (it holds per-run approvals). */
  policy: PolicyGate;
  onStep?: (run: AgentRun) => void;
  /** Ask a human. Resolve true = confirm, false = reject. If absent, needsHuman runs are rejected. */
  confirm?: (run: AgentRun) => Promise<boolean>;
  config?: Partial<AgentConfig>;
  /** Where each dependency came from, for honest labels. */
  sources?: { wallet: "real-module" | "fake"; bitrefill: "real-module" | "fake"; bridge: "real-module" | "fake" };
  /** Injected Anthropic client (tests); otherwise one is created from ANTHROPIC_API_KEY. */
  anthropic?: unknown;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): AgentConfig {
  const bm = (env.BITREFILL_MODE || "offline").trim();
  return {
    agentMode: (env.AGENT_MODE || "scripted").trim() === "llm" ? "llm" : "scripted",
    model: (env.AGENT_MODEL || "claude-sonnet-5-5").trim(),
    bitrefillMode: bm === "real" || bm === "test" ? bm : "offline",
    walletKind: (env.ZEC_WALLET || "mock").trim(),
    network: (env.ZEC_NETWORK || "testnet").trim() === "mainnet" ? "mainnet" : "testnet",
    inrPerUsd: Number(env.INR_PER_USD || 84),
    testnetSendZat: Number(env.ZEC_TESTNET_SEND_ZAT || 100_000), // 0.001 TAZ
    destAddress: env.ZEC_DEST_ADDRESS?.trim() || undefined,
    refundAddress: env.ZEC_REFUND_ADDRESS?.trim() || undefined,
    usdcRecipientFallback: env.USDC_RECIPIENT?.trim() || undefined,
    orderPollMs: Number(env.ORDER_POLL_MS || 20_000),
    confirmWaitMs: Number(env.ZEC_CONFIRM_WAIT_MS || 600_000),
    maxLlmTurns: Number(env.AGENT_MAX_TURNS || 12),
    gatewayTimeoutMs: env.GATEWAY_TIMEOUT_MS ? Number(env.GATEWAY_TIMEOUT_MS) : undefined,
  };
}

/**
 * What actually runs, after any fallback (for the CLI header and the web chips). ZEC_WALLET=zingo with a wallet
 * init error (e.g. ZEC_NETWORK=mainnet) runs the fake wallet; say so instead of echoing the requested kind.
 */
export function effectiveModes(cfg: Pick<AgentConfig, "walletKind" | "network" | "bitrefillMode">, sources?: AgentDeps["sources"]) {
  const walletFallback = sources?.wallet === "fake" && cfg.walletKind !== "mock";
  const bitrefillFallback = sources?.bitrefill === "fake" && cfg.bitrefillMode !== "offline";
  return {
    wallet: sources?.wallet === "fake" ? (walletFallback ? `mock (fallback from ${cfg.walletKind})` : "mock") : cfg.walletKind,
    network: walletFallback ? `none (mock wallet; ${cfg.network} requested)` : cfg.network,
    bitrefill: bitrefillFallback ? `fixture (fallback from ${cfg.bitrefillMode})` : cfg.bitrefillMode,
    walletFallback,
    bitrefillFallback,
  };
}

const rel = (p: string) => new URL(p, import.meta.url).href;

/**
 * Load the real T1/T2 modules if present, else fakes. Set ZR_USE_FAKES=1 to force fakes.
 * This is the single swap point: nothing else in agent/ imports wallet/bitrefill/bridge.
 */
export async function loadAdapters(env: Record<string, string | undefined> = process.env): Promise<{
  wallet: WalletLike;
  bitrefill: BitrefillLike;
  bridge: BridgeFn;
  gateway: Gateway;
  sources: NonNullable<AgentDeps["sources"]>;
  warnings: string[];
}> {
  const fakes = await import("./fakes");
  const warnings: string[] = [];
  const force = env.ZR_USE_FAKES === "1";
  let wallet: WalletLike = fakes.createFakeWallet();
  let bitrefill: BitrefillLike = fakes.createFakeBitrefill();
  let bridge: BridgeFn = fakes.fakeBridgeQuote;
  const sources: NonNullable<AgentDeps["sources"]> = { wallet: "fake", bitrefill: "fake", bridge: "fake" };
  if (!force && (env.ZEC_WALLET || "").trim().toLowerCase() === "zingo" && !env.ZINGO_CMD) {
    // Fail fast (no silent fallback, no hang): the operator asked for the real testnet wallet.
    const z = await import(rel("../wallet/zingo.ts"));
    await z.zingoPreflight({ env });
  }
  if (!force) {
    try {
      const m = await import(rel("../wallet/index.ts"));
      wallet = await m.createWallet();
      sources.wallet = "real-module";
    } catch (e) {
      warnings.push(`wallet: using fake (${(e as Error).message.split("\n")[0]})`);
    }
    try {
      const m = await import(rel("../bitrefill/index.ts"));
      bitrefill = await m.createBitrefill();
      sources.bitrefill = "real-module";
    } catch (e) {
      warnings.push(`bitrefill: using fake (${(e as Error).message.split("\n")[0]})`);
    }
    try {
      const m = await import(rel("../bridge/index.ts"));
      if (typeof m.getBridgeQuote !== "function") throw new Error("getBridgeQuote not exported");
      bridge = m.getBridgeQuote;
      sources.bridge = "real-module";
    } catch (e) {
      warnings.push(`bridge: using fake (${(e as Error).message.split("\n")[0]})`);
    }
  }
  const gw = await import(rel("../gateway/index.ts"));
  let gateway: Gateway = new gw.MockGateway();
  if (!force) {
    try {
      gateway = gw.createGateway(env);
    } catch (e) {
      warnings.push(`gateway: using mock (${(e as Error).message.split("\n")[0]})`);
    }
  }
  return { wallet, bitrefill, bridge, gateway, sources, warnings };
}
