// Request guard for the local web UI's POST endpoints (/api/run, /api/confirm/:id).
// The Confirm button is the human-in-the-loop guarantee, so a cross-site page must not be able to press it:
//   - POSTs must be JSON (a plain HTML form or a no-preflight fetch cannot send application/json cross-site),
//   - an Origin header, when present, must name the same host:port the request was sent to,
//   - when the server is bound to loopback, the Host header must be a loopback name (blocks DNS rebinding).

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(h: string): boolean {
  return LOOPBACK.has(h.toLowerCase());
}

function hostnameOf(hostHeader: string): string {
  // "localhost:3000" -> "localhost", "[::1]:3000" -> "[::1]"
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
  return (m ? m[1]! : hostHeader).toLowerCase();
}

/** Returns null when the POST is allowed, otherwise a short reason (respond 403). */
export function checkPost(req: Request, bindHost: string): string | null {
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(ct)) return "content-type must be application/json";
  const host = req.headers.get("host") ?? "";
  if (!host) return "missing Host header";
  if (isLoopbackHost(bindHost) && !isLoopbackHost(hostnameOf(host))) return `Host ${host} is not a loopback name`;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return "bad Origin header";
    }
    if (o.host.toLowerCase() !== host.toLowerCase()) return `cross-origin POST from ${origin} refused`;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return `cross-site POST (${site}) refused`;
  return null;
}
