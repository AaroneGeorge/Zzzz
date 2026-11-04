// bun run serve  →  http://localhost:3000
import { join } from "node:path";
import { checkPost } from "./guard";
import { configFromEnv, createDefaultDeps, newRunId, runAgent, type AgentRun } from "../agent";

const PORT = Number(process.env.PORT || 3000);
// Loopback by default: the run and Confirm endpoints have no auth. HOST=0.0.0.0 opts in to LAN exposure.
const HOST = process.env.HOST || "127.0.0.1";
const INDEX = join(import.meta.dir, "index.html");

const cfg = configFromEnv();
const deps = await createDefaultDeps().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
const runs = new Map<string, AgentRun>();
const listeners = new Map<string, Set<(r: AgentRun) => void>>();
const pendingConfirm = new Map<string, (ok: boolean) => void>();

function publish(r: AgentRun) {
  const snap = structuredClone(r);
  runs.set(r.id, snap);
  for (const fn of listeners.get(r.id) ?? []) fn(snap);
}

function startRun(prompt: string): string {
  const id = newRunId();
  runAgent(prompt, {
    ...deps,
    runId: id,
    onStep: publish,
    confirm: (r) =>
      new Promise<boolean>((resolve) => {
        pendingConfirm.set(r.id, resolve);
        publish(r);
      }),
  })
    .then(publish)
    .catch((e) => console.error("run crashed", id, e))
    .finally(() => pendingConfirm.delete(id));
  return id;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function sse(id: string): Response {
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (r: AgentRun) => {
        try {
          controller.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(r)}\n\n`));
          if (r.finishedAt) {
            controller.enqueue(enc.encode(`event: done\ndata: {}\n\n`));
          }
        } catch {
          cleanup();
        }
      };
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(send);
      const hb = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: hb\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);
      cleanup = () => {
        clearInterval(hb);
        set.delete(send);
      };
      const cur = runs.get(id);
      if (cur) send(cur);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // SSE streams stay open
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "POST") {
      const why = checkPost(req, HOST);
      if (why) return json({ error: `forbidden: ${why}` }, 403);
    }
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return new Response(Bun.file(INDEX), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (req.method === "POST" && p === "/api/run") {
      const body = (await req.json().catch(() => ({}))) as { prompt?: string };
      const prompt = String(body.prompt ?? "").trim().slice(0, 500);
      if (!prompt) return json({ error: "prompt is required" }, 400);
      return json({ id: startRun(prompt) });
    }
    let m = /^\/api\/state\/([\w-]+)$/.exec(p);
    if (req.method === "GET" && m) {
      const r = runs.get(m[1]!);
      return r ? json(r) : json({ error: "unknown run" }, 404);
    }
    m = /^\/api\/events\/([\w-]+)$/.exec(p);
    if (req.method === "GET" && m) return sse(m[1]!);
    m = /^\/api\/confirm\/([\w-]+)$/.exec(p);
    if (req.method === "POST" && m) {
      const body = (await req.json().catch(() => ({}))) as { approve?: boolean };
      const resolve = pendingConfirm.get(m[1]!);
      if (!resolve) return json({ error: "nothing waiting for confirmation on this run" }, 409);
      pendingConfirm.delete(m[1]!);
      resolve(body.approve === true);
      return json({ ok: true, approve: body.approve === true });
    }
    if (req.method === "GET" && p === "/api/policy") {
      return json({
        ...deps.policy.status(),
        sources: deps.sources,
        warnings: deps.warnings,
        config: { agentMode: cfg.agentMode, model: cfg.model, bitrefillMode: cfg.bitrefillMode, walletKind: cfg.walletKind, network: cfg.network, gateway: deps.gateway.view, gatewayAddress: deps.gateway.address },
      });
    }
    if (req.method === "GET" && p === "/api/runs") {
      return json([...runs.values()].slice(-20).reverse().map((r) => ({ id: r.id, prompt: r.prompt, status: r.status, createdAt: r.createdAt })));
    }
    return json({ error: "not found" }, 404);
  },
});

console.log("Agent pays shielded ZEC to a viewing-key gateway; only a verified payment unlocks the Bitrefill order (testnet + Bitrefill test products)");
console.log(`ZecRecharge UI on http://${HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST}:${server.port}${HOST === "0.0.0.0" || HOST === "::" ? " (bound to all interfaces: no auth, anyone on your network can run and confirm)" : ""}  (agent=${cfg.agentMode}, bitrefill=${cfg.bitrefillMode}, wallet=${cfg.walletKind}, gateway=${deps.gateway.view}, sources=${JSON.stringify(deps.sources)})`);
for (const w of deps.warnings) console.log(`  note: ${w}`);
