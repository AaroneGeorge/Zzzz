// Hosted Bitrefill eCommerce MCP over Streamable HTTP, authenticated with a *guest*
// OAuth client_credentials token (no Bitrefill account, no API key).
//
// Flow verified live on 2026-11-04:
//   POST /oauth/mcp/register {grant_types:["client_credentials"], token_endpoint_auth_method:"none"} -> 201 {client_id}
//   POST /oauth/mcp/token grant_type=client_credentials&client_id=..&scope=mcp&resource=https://api.bitrefill.com/mcp
//        -> {access_token, expires_in: 21600, scope: "mcp"}
//   POST /mcp  (JSON-RPC 2.0) with Accept: application/json, text/event-stream  (400 without it)
//        -> text/event-stream body "event: message\ndata: {...}"; no Mcp-Session-Id (stateless)
// Tool results come back as a single text block in TOON format (not JSON), no structuredContent.
import { decode as decodeToon } from "@toon-format/toon";
import { BitrefillError, type FetchLike, type McpResult } from "./types";

export const MCP_URL = "https://api.bitrefill.com/mcp";
export const OAUTH_BASE = "https://api.bitrefill.com/oauth/mcp";
const PROTOCOL_VERSION = "2025-06-18";

export interface McpGuestOpts {
  fetch?: FetchLike;
  url?: string;
  oauthBase?: string;
  clientName?: string;
  timeoutMs?: number;
}

/** Parse a Streamable-HTTP response body: either plain JSON or SSE "data:" frames. */
export function parseRpcBody(contentType: string, body: string): any[] {
  if (contentType.includes("text/event-stream")) {
    const out: any[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.trim()) out.push(JSON.parse(data));
    }
    return out;
  }
  const t = body.trim();
  if (!t) return [];
  const j = JSON.parse(t);
  return Array.isArray(j) ? j : [j];
}

/** Bitrefill MCP text is TOON; fall back to JSON, then to the raw string. */
export function decodeToolText(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  try {
    return decodeToon(t);
  } catch {
    return text;
  }
}

export class McpGuestClient {
  private f: FetchLike;
  private url: string;
  private oauthBase: string;
  private clientName: string;
  private timeoutMs: number;
  private clientId?: string;
  private token?: { value: string; expiresAt: number };
  private sessionId?: string;
  private initialized = false;
  private nextId = 1;

  constructor(opts: McpGuestOpts = {}) {
    this.f = opts.fetch ?? fetch;
    this.url = opts.url ?? MCP_URL;
    this.oauthBase = opts.oauthBase ?? OAUTH_BASE;
    this.clientName = opts.clientName ?? "ZecRecharge (Free Society hackathon)";
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async http(url: string, init: RequestInit): Promise<Response> {
    return this.f(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /** Register a public client once, then mint a 6 h guest token (refreshed 5 min early). */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.clientId) {
      const r = await this.http(`${this.oauthBase}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: this.clientName,
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "none",
          redirect_uris: [],
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.client_id) throw new BitrefillError(`MCP client register failed (${r.status})`, r.status, j.error, j);
      this.clientId = j.client_id;
    }
    const r = await this.http(`${this.oauthBase}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId!,
        scope: "mcp",
        resource: this.url,
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new BitrefillError(`MCP guest token failed (${r.status})`, r.status, j.error, j);
    const ttl = Number(j.expires_in ?? 3600) * 1000;
    this.token = { value: j.access_token, expiresAt: Date.now() + Math.max(ttl - 300_000, 30_000) };
    return this.token.value;
  }

  private async post(payload: object, retried = false): Promise<any[]> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const r = await this.http(this.url, { method: "POST", headers, body: JSON.stringify(payload) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (r.status === 401 && !retried) {
      this.token = undefined;
      this.initialized = false;
      this.sessionId = undefined;
      return this.post(payload, true);
    }
    const body = await r.text();
    if (r.status === 202) return [];
    if (!r.ok) {
      let msg = body.slice(0, 300);
      try {
        msg = parseRpcBody(r.headers.get("content-type") ?? "", body)[0]?.error?.message ?? msg;
      } catch {}
      throw new BitrefillError(`MCP HTTP ${r.status}: ${msg}`, r.status);
    }
    return parseRpcBody(r.headers.get("content-type") ?? "", body);
  }

  async rpc(method: string, params?: object): Promise<any> {
    const id = this.nextId++;
    const msgs = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const res = msgs.find((m) => m.id === id) ?? msgs[msgs.length - 1];
    if (!res) throw new BitrefillError(`MCP ${method}: empty response`);
    if (res.error) throw new BitrefillError(`MCP ${method}: ${res.error.message}`, undefined, String(res.error.code), res.error);
    return res.result;
  }

  async initialize(): Promise<any> {
    if (this.initialized) return;
    const result = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "zecrecharge", version: "0.1.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    this.initialized = true;
    return result;
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.initialize();
    return (await this.rpc("tools/list")).tools ?? [];
  }

  async callTool<T = unknown>(tool: string, args: Record<string, unknown>): Promise<McpResult<T>> {
    await this.initialize();
    const result = await this.rpc("tools/call", { name: tool, arguments: args });
    const text: string = (result?.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    const data = (result?.structuredContent ?? decodeToolText(text)) as T;
    return { tool, data, text, isError: !!result?.isError, mode: "real", source: "mcp-guest" };
  }
}
