// The UI renders the agent's text with a tiny markdown function inside index.html; test it in isolation.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "index.html"), "utf8");
const escSrc = /const esc = [^\n]+/.exec(html)![0];
const mdSrc = /function md\(src\) \{[\s\S]*?\n\}\n/.exec(html)![0];
const md = new Function(`${escSrc}\n${mdSrc}\nreturn md;`)() as (s: string) => string;

describe("agent text markdown (web UI)", () => {
  test("bold, code and lists render", () => {
    const out = md("**Order:** `abc123` placed\n- step one\n- step two\n1. first\n2. second");
    expect(out).toContain("<strong>Order:</strong>");
    expect(out).toContain("<code>abc123</code>");
    expect(out).toContain("<ul><li>step one</li><li>step two</li></ul>");
    expect(out).toContain("<ol><li>first</li><li>second</li></ol>");
  });
  test("HTML is escaped before markdown (no injection)", () => {
    const out = md('**<img src=x onerror=alert(1)>** `<script>` - <a href="javascript:1">x</a>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  test("no tag carries attributes", () => {
    const out = md("**a** *b* `c`\n- d\n# e");
    for (const tag of out.match(/<[a-z]+[^>]*>/g) ?? []) expect(tag).toMatch(/^<[a-z]+( class="mdl")?>$/);
  });
});
