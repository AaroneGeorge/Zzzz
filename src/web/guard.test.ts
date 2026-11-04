import { describe, expect, test } from "bun:test";
import { checkPost } from "./guard";

const post = (headers: Record<string, string>) => new Request("http://localhost:3000/api/confirm/run-1", { method: "POST", headers, body: "{}" });
const JSON_CT = { "content-type": "application/json" };

describe("web POST guard", () => {
  test("same-origin JSON POST from the UI is allowed", () => {
    expect(checkPost(post({ ...JSON_CT, host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }), "127.0.0.1")).toBeNull();
  });
  test("curl-style POST without Origin is allowed", () => {
    expect(checkPost(post({ ...JSON_CT, host: "127.0.0.1:3000" }), "127.0.0.1")).toBeNull();
  });
  test("cross-origin POST to /api/confirm is refused", () => {
    expect(checkPost(post({ ...JSON_CT, host: "localhost:3000", origin: "https://evil.example" }), "127.0.0.1")).toContain("cross-origin");
  });
  test("cross-site fetch metadata is refused even without Origin", () => {
    expect(checkPost(post({ ...JSON_CT, host: "localhost:3000", "sec-fetch-site": "cross-site" }), "127.0.0.1")).toContain("cross-site");
  });
  test("non-JSON content type (form / text/plain CSRF) is refused", () => {
    expect(checkPost(post({ "content-type": "text/plain", host: "localhost:3000" }), "127.0.0.1")).toContain("content-type");
  });
  test("DNS rebinding: non-loopback Host on a loopback bind is refused", () => {
    expect(checkPost(post({ ...JSON_CT, host: "evil.example:3000", origin: "http://evil.example:3000" }), "127.0.0.1")).toContain("loopback");
  });
  test("HOST=0.0.0.0 accepts a LAN host when Origin matches", () => {
    expect(checkPost(post({ ...JSON_CT, host: "192.168.1.5:3000", origin: "http://192.168.1.5:3000" }), "0.0.0.0")).toBeNull();
  });
});
