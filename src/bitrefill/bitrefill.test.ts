// Offline unit tests: every network call goes through an injected fake fetch (no real HTTP).
import { describe, expect, test } from "bun:test";
import { createBitrefill, McpGuestClient, OfflineBitrefill, type FetchLike } from "./index";
import { decodeToolText, parseRpcBody } from "./mcp";
import { invoiceFromV2, maskCode, numericValue, orderFromV2 } from "./map";
import searchJio from "./fixtures/mcp/search-jio-IN.json";

type Call = { url: string; init?: RequestInit; body?: string };

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init, body: typeof init.body === "string" ? init.body : init.body ? String(init.body) : undefined });
    return handler(url, init, calls.length);
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (o: unknown) => new Response(`event: message\ndata: ${JSON.stringify(o)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const hdr = (init: RequestInit | undefined, k: string) => new Headers(init?.headers as any).get(k);

/** Fake hosted MCP: register -> token -> initialize -> notifications -> tools/call (returns recorded TOON). */
function mcpServer(toolText = searchJio.text, opts: { expire401Once?: boolean } = {}) {
  let tokens = 0;
  let sent401 = false;
  return fakeFetch(async (url, init) => {
    if (url.endsWith("/oauth/mcp/register")) return json({ client_id: "cid-1", grant_types: ["client_credentials"] }, 201);
    if (url.endsWith("/oauth/mcp/token")) {
      tokens++;
      return json({ access_token: `tok-${tokens}`, token_type: "bearer", expires_in: 21600, scope: "mcp" });
    }
    if (url.endsWith("/mcp")) {
      if (!String(hdr(init, "accept")).includes("text/event-stream")) return json({ jsonrpc: "2.0", error: { code: -32000, message: "Accept header must include both" }, id: null }, 400);
      if (opts.expire401Once && !sent401 && hdr(init, "authorization") === "Bearer tok-1") {
        sent401 = true;
        return new Response("Unauthorized", { status: 401 });
      }
      const msg = JSON.parse(String(init.body));
      if (!("id" in msg)) return new Response(null, { status: 202 });
      if (msg.method === "initialize") return sse({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Bitrefill MCP" } } });
      if (msg.method === "tools/call") return sse({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: toolText }] } });
      return sse({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("MCP transport helpers", () => {
  test("parseRpcBody handles SSE frames and plain JSON", () => {
    expect(parseRpcBody("text/event-stream", 'event: message\ndata: {"id":1,"result":{"a":1}}\n\n')).toEqual([{ id: 1, result: { a: 1 } }]);
    expect(parseRpcBody("application/json", '{"id":2,"result":{}}')).toEqual([{ id: 2, result: {} }]);
  });
  test("decodeToolText decodes the recorded TOON search result", () => {
    const d: any = decodeToolText(searchJio.text);
    expect(d.found).toBe(3);
    expect(d.products.map((p: any) => p.slug)).toContain("reliance-jio-india-bundles");
  });
});

describe("McpGuestClient", () => {
  test("register -> client_credentials token -> initialize -> tools/call, with required Accept header", async () => {
    const f = mcpServer();
    const c = new McpGuestClient({ fetch: f });
    const r = await c.callTool<any>("search-products", { query: "jio", country: "IN", intent: "x" });
    expect(r.mode).toBe("real");
    expect(r.source).toBe("mcp-guest");
    expect(r.data.products[0].slug).toBe("reliance-jio-india-bundles");
    const tokenCall = f.calls.find((c) => c.url.endsWith("/token"))!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("mcp");
    expect(form.get("resource")).toBe("https://api.bitrefill.com/mcp");
    const mcpCalls = f.calls.filter((c) => c.url.endsWith("/mcp"));
    expect(mcpCalls.every((c) => hdr(c.init, "accept") === "application/json, text/event-stream")).toBe(true);
    expect(mcpCalls.map((c) => JSON.parse(c.body!).method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });
  test("re-mints the guest token once on 401", async () => {
    const f = mcpServer(searchJio.text, { expire401Once: true });
    const r = await new McpGuestClient({ fetch: f }).callTool<any>("search-products", { query: "jio", intent: "x" });
    expect(r.data.found).toBe(3);
    expect(f.calls.filter((c) => c.url.endsWith("/token")).length).toBe(2);
  });
});

describe("mappers", () => {
  test("numericValue", () => {
    expect(numericValue("30")).toBe(30);
    expect(numericValue("₹39.37 Talktime Top-Up")).toBe(39.37);
    expect(numericValue("30GB – 30 Day Data Pack")).toBeUndefined();
    expect(numericValue(10)).toBe(10);
  });
  test("invoice status normalisation + honesty tags", () => {
    const testInv = invoiceFromV2({ id: "i1", status: "complete", payment: { method: "balance", status: "paid", price: 0, currency: "USD" }, orders: [{ id: "o1", product: { id: "test-gift-card-code", value: "10" } }] });
    expect(testInv.status).toBe("test_autopaid");
    expect(testInv.mode).toBe("test");
    const realUnpaid = invoiceFromV2({ id: "i2", status: "unpaid", payment: { method: "usdc_base", address: "0xabc", price: 3.1, currency: "USDC" }, orders: [{ id: "o2", product: { id: "reliance-jio-india-bundles" } }] });
    expect(realUnpaid.status).toBe("unpaid");
    expect(realUnpaid.mode).toBe("real");
    expect(realUnpaid.payTo).toEqual({ address: "0xabc", amount: "3.1", currency: "USDC" });
    expect(invoiceFromV2({ id: "i3", status: "payment_error", payment: { method: "lightning" }, orders: [] }).status).toBe("failed");
  });
  test("order redemption_info as object or string", () => {
    const a = orderFromV2({ id: "o", status: "delivered", product: { id: "test-gift-card-code" }, redemption_info: { code: "ABCD-1234", instructions: "x" } });
    expect(a.code).toBe("ABCD-1234");
    expect(a.mode).toBe("test");
    const b = orderFromV2({ id: "o", status: "delivered", product: { id: "amazon-us" }, redemption_info: "Go to example.com" });
    expect(b.code).toBeUndefined();
    expect(b.instructions).toBe("Go to example.com");
    expect(b.mode).toBe("real");
    expect(maskCode("ABCD-1234")).toBe("*****1234");
  });
});

describe("createBitrefill factory", () => {
  test("offline: fixtures everywhere, all tagged fixture", async () => {
    const b = createBitrefill({ mode: "offline", liveSearch: false, apiKey: "" });
    expect(b.mode).toBe("offline");
    expect((await b.ping()).mode).toBe("fixture");
    const prods = await b.searchProducts("jio", { country: "IN", includeTest: true });
    expect(prods.every((p) => p.mode === "fixture")).toBe(true);
    expect(prods.map((p) => p.id)).toContain("reliance-jio-india-bundles");
    expect(prods.map((p) => p.id)).toContain("test-gift-card-code");
    const pk = await b.getProductPackages("reliance-jio-india-bundles");
    expect(pk.length).toBe(50);
    expect(pk[0].priceUsd).toBeDefined();
  });
  test("test/real without a key degrade to offline and say why", () => {
    const b = createBitrefill({ mode: "test", apiKey: "", liveSearch: false });
    expect(b.mode).toBe("offline");
    expect(b.degradedReason).toContain("BITREFILL_API_KEY");
  });
  test("offline search uses live guest MCP when allowed, falls back to labelled fixtures on failure", async () => {

    const fm = mcpServer();
    const ok = createBitrefill({ mode: "offline", apiKey: "", liveSearch: true, fetch: fm });
    const live = await ok.searchProducts("jio", { country: "in" });
    expect(live.every((p) => p.mode === "real" && p.source === "mcp-guest")).toBe(true);
    const call = fm.calls.filter((c) => c.url.endsWith("/mcp")).map((c) => JSON.parse(c.body!)).find((b) => b?.method === "tools/call");
    expect(call.params.arguments).toMatchObject({ query: "jio", country: "IN" }); // upper-cased (MCP is case-sensitive)
    expect(call.params.arguments.intent).toBeTruthy(); // required by the live schema
    const down = createBitrefill({ mode: "offline", apiKey: "", liveSearch: true, fetch: fakeFetch(() => { throw new Error("ENETUNREACH"); }) });
    const fb = await down.searchProducts("jio", { country: "IN" });
    expect(fb.length).toBeGreaterThan(0);
    expect(fb.every((p) => p.mode === "fixture" && (p.fallbackReason ?? "").includes("ENETUNREACH"))).toBe(true);
  });
  test("test mode: v2 calls with Bearer key, refuses non-test products", async () => {
    const f = fakeFetch((url, init) => {
      if (url.endsWith("/v2/ping")) return json({ meta: {}, data: { message: "pong" } });
      if (url.endsWith("/v2/invoices") && init.method === "POST")
        return json({ data: { id: "inv-1", status: "unpaid", payment: { method: "balance", status: "unpaid", price: 0, currency: "USD" }, orders: [{ id: "ord-1", status: "created", product: { id: "test-gift-card-code", value: "10" } }] } });
      if (url.endsWith("/v2/invoices/inv-1")) return json({ data: { id: "inv-1", status: "complete", payment: { method: "balance", status: "paid" }, orders: [{ id: "ord-1", product: { id: "test-gift-card-code" } }] } });
      if (url.endsWith("/v2/orders/ord-1")) return json({ data: { id: "ord-1", status: "delivered", product: { id: "test-gift-card-code" }, redemption_info: { code: "TEST-CODE-9999" } } });
      return json({ message: "nope" }, 404);
    });
    const b = createBitrefill({ mode: "test", apiKey: "k_test", fetch: f, liveSearch: false });
    const p = await b.ping();
    expect(p).toMatchObject({ ok: true, message: "pong", mode: "test", source: "v2" });
    expect(hdr(f.calls[0].init, "authorization")).toBe("Bearer k_test");
    expect(f.calls[0].url).toBe("https://api.bitrefill.com/v2/ping");
    await expect(b.createInvoice([{ productId: "reliance-jio-india-bundles", packageId: "x" }], "balance", { autoPay: true })).rejects.toThrow(/refuses non-test/);
    const inv = await b.createInvoice([{ productId: "test-gift-card-code", value: 10 }], "balance", { autoPay: true });
    const body = JSON.parse(f.calls.find((c) => c.url.endsWith("/v2/invoices"))!.body!);
    expect(body).toEqual({ products: [{ product_id: "test-gift-card-code", quantity: 1, value: 10 }], payment_method: "balance", auto_pay: true });
    expect(inv.mode).toBe("test");
    const done = await b.waitForInvoice(inv.id, { timeoutMs: 1000, intervalMs: 10 });
    expect(done.status).toBe("test_autopaid");
    const ord = await b.getOrder(done.orderIds[0]);
    expect(ord).toMatchObject({ code: "TEST-CODE-9999", mode: "test", source: "v2" });
  });
  test("real mode refuses auto_pay of real products unless explicitly allowed", async () => {
    const f = fakeFetch(() => json({ data: {} }));
    const b = createBitrefill({ mode: "real", apiKey: "k", fetch: f, liveSearch: false, allowRealSpend: false });
    await expect(b.createInvoice([{ productId: "reliance-jio-india-bundles", packageId: "₹14.95 Talktime Top-Up", phoneNumber: "+919999999999" }], "balance", { autoPay: true })).rejects.toThrow(/spend/);
    expect(f.calls.length).toBe(0);
  });
  test("v2 errors surface status + error_code", async () => {
    const f = fakeFetch(() => json({ message: "Invalid authorization token", status: "invalid_token" }, 401));
    const b = createBitrefill({ mode: "test", apiKey: "bad", fetch: f, liveSearch: false });
    await expect(b.ping()).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  });
});

describe("OfflineBitrefill fixtures", () => {
  test("free test product: autopaid + fixture code; -fail variant fails; real product stays unpaid", async () => {
    const o = new OfflineBitrefill();
    const inv = await o.createInvoice([{ productId: "test-gift-card-code", value: 10 }], "balance", { autoPay: true });
    expect(inv).toMatchObject({ status: "test_autopaid", mode: "fixture", source: "fixture" });
    const ord = await o.getOrder(inv.orderIds[0]);
    expect(ord.code).toStartWith("FIXTURE-TEST-");
    expect(ord.mode).toBe("fixture");
    const fail = await o.createInvoice([{ productId: "test-gift-card-code-fail", value: 10 }], "balance", { autoPay: true });
    expect(fail.status).toBe("failed");
    const real = await o.createInvoice([{ productId: "reliance-jio-india-bundles", packageId: "₹14.95 Talktime Top-Up", phoneNumber: "+919999999999" }], "usdc_base");
    expect(real.status).toBe("unpaid");
    expect(real.mode).toBe("fixture");
    expect(real.payTo?.address).toMatch(/^0x/);
    expect(real.priceUsd).toBe("0.23");
    await expect(o.createInvoice([{ productId: "test-gift-card-code" }], "usdc_base", { autoPay: true })).rejects.toThrow(/auto_pay/);
  });
  test("mcpCall serves recorded responses", async () => {
    const r = await new OfflineBitrefill().mcpCall<any>("search-products", { query: "jio", country: "IN", intent: "anything" });
    expect(r.mode).toBe("fixture");
    expect(r.data.products.length).toBe(3);
  });
});
