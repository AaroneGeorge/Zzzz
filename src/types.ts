export type Money = { amount: string; currency: "INR"|"USD"|"EUR"|"ZEC"|"TAZ"|"USDC" };
export interface Product { id: string; name: string; packageId?: string; value?: number; currency: string; country?: string; isTest: boolean; }
export interface Invoice { id: string; status: "unpaid"|"paid"|"complete"|"failed"|"test_autopaid"; paymentMethod: string; payTo?: { address: string; amount: string; currency: string }; orderIds: string[]; expiresAt?: string; }
export interface Order { id: string; status: string; code?: string; link?: string; instructions?: string; }
export interface BridgeQuote { kind: "dry"|"live"; amountInZec: string; amountOutUsdc: string; depositAddress?: string; quoteId?: string; expiresAt?: string; provider: "near-intents-1click"; }
export interface PolicyDecision { allowed: boolean; needsHuman: boolean; reasons: string[]; spentTodayInr: number; remainingInr: number; }
export interface ShieldedSend { txid: string; network: "testnet"|"mainnet"; amountZat: number; to: string; memo: string; confirmed: boolean; explorerUrl: string; mode: "zecli"|"zingo"|"manual"; }
export interface RunState { id: string; steps: Array<{ name: string; status: "pending"|"running"|"ok"|"failed"|"skipped"; detail?: unknown; at: string }>; }
