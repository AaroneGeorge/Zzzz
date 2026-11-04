# Bitrefill developer-experience feedback (ZecRecharge, Free Society Hack Mumbai, 2026-11-04)

Collected while building a bun/TypeScript agent that searches Bitrefill through the **hosted MCP with a guest
`client_credentials` token** and the **REST v2 API**, then quotes a ZEC to USDC-on-Base payment through NEAR Intents 1Click.
Every item below was reproduced live on 2026-11-04 between 18:20 and 18:35 IST. Each one gives a repro, what we
expected, and a suggested fix. In the repros, `$T` is a guest access token and `$CID` is a guest client id.

Status of v2 items: we had **no API key** while writing this, so the v2 notes come from the published
OpenAPI reference (`docs.bitrefill.com/reference/*.md`), not from live calls. They are marked *(docs)*.

---

## What worked well

1. **The guest checkout auth is great.** Two calls give a working token with no account: `POST /oauth/mcp/register`
   (201 with a `client_id`) and then `POST /oauth/mcp/token` (6 h token). The token endpoint accepts both form-encoded and
   JSON bodies. This is the lowest-friction "agent can shop" onboarding we have seen.
2. **The errors that tell you exactly what to do.** The old key-in-URL endpoint answers *"This endpoint has been shut
   down. Connect to /mcp and send your API key in the Authorization header instead"*. A missing Accept header answers
   *"Accept header must include both application/json and text/event-stream"*. Both are perfect error messages.
3. **The MCP server is stateless.** No `Mcp-Session-Id` is needed, so a plain `fetch` POST works and there's no SDK
   dependency. Our whole MCP client is about 150 lines.
4. **The tool annotations are useful.** `readOnlyHint` and `destructiveHint` are set correctly (`buy-products` is
   destructive and not idempotent). Our spending-policy gate uses them directly: read-only tools pass and destructive
   ones need the mandate.
5. **Product details are rich and agent-friendly.** `recipient_type` tells the agent whether a phone number is needed.
   `payment_methods` is grouped into `address_based`, `link_only` and `balance`, so an agent can tell "pay on-chain now"
   from "send the user a link". There are also `in_stock`, ratings and reviews.
6. **`RESOURCE_NOT_FOUND` comes with `suggestions[]`.** That is a good touch for agents recovering from a wrong slug.
7. **The India catalog is deep.** Jio Bundles has 50 packages from $0.11. Airtel prepaid, Airtel bundles and Airtel DTH
   are there too. It's a credible "buy everyday things with crypto in India" story.
8. **The docs are machine-readable.** `docs.bitrefill.com/llms.txt` exists, and every page has a `.md` twin with the
   embedded OpenAPI. We pulled the exact schemas in minutes. Every docs site should do this.
9. **Responses carry standard `ratelimit-*` headers.**

---

## Rough edges (repro, then expected, then suggested fix)

### MCP and auth

**F1. The docs still tell you to put the API key in the MCP URL, and that endpoint returns 410.**
- Repro: the "eCommerce MCP" page (`docs.bitrefill.com/docs/ecommerce-mcp.md`, around line 35) says *"use an API key in
  the URL instead: `https://api.bitrefill.com/mcp/YOUR_API_KEY`"*. Then
  `curl -X POST https://api.bitrefill.com/mcp/anything -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
  returns HTTP **410** *"This endpoint has been shut down…"*. The partner guide says keys are "never accepted in the
  URL". The two pages contradict each other.
- Expected: one documented way.
- Fix: update the eCommerce MCP page and the setup guides (Cursor, Claude Desktop and similar configs) to
  `Authorization: Bearer <key>`. Many MCP clients can't set headers, so link to a header-capable config for each of them.

**F2. A missing `Accept: application/json, text/event-stream` gives a 400.**
- Repro: POST `initialize` to `/mcp` with a Bearer token and no Accept header. The response is 400 with JSON-RPC
  -32000.
- Expected: the Streamable HTTP spec lets a server answer with plain JSON. Most HTTP clients (curl, fetch, requests)
  send `*/*` or nothing at all.
- Fix: treat a missing Accept or `*/*` as "JSON is fine" and reply with `application/json`. If you keep the 400,
  put a curl example with that header at the top of the MCP docs.

**F3. OAuth discovery doesn't follow the MCP auth spec, so generic MCP clients can't auto-discover.**
- Repro:
  - `curl -i -X POST https://api.bitrefill.com/mcp` returns 401 with `WWW-Authenticate: Bearer error="invalid_token"`.
    It has **no `resource_metadata=` parameter**, which MCP auth (2025-06-18) requires.
  - `GET /.well-known/oauth-protected-resource/mcp` returns **404**. This is the RFC 9728 path-suffixed form that
    clients query first for a resource at `/mcp`. Only `/.well-known/oauth-protected-resource` works.
  - That document says `"resource":"https://api.bitrefill.com/"`, but the partner guide tells you to request
    `resource=https://api.bitrefill.com/mcp`. Both values are accepted.
  - `GET /.well-known/oauth-authorization-server` at the root returns 404. Only the path-inserted
    `/.well-known/oauth-authorization-server/oauth/mcp` works.
- Expected: `WWW-Authenticate: Bearer resource_metadata="https://api.bitrefill.com/.well-known/oauth-protected-resource/mcp"`,
  plus a PRM whose `resource` equals the MCP URL.
- Fix: add the header and the path-suffixed PRM route, and make `resource` consistent with the docs.

**F4. The token endpoint requires `resource`, but the error is only discoverable by trial.**
- Repro: `curl -X POST https://api.bitrefill.com/oauth/mcp/token -d grant_type=client_credentials -d client_id=$CID -d scope=mcp`
  returns `{"error":"invalid_target","error_description":"Invalid resource: resource is required"}`.
- Expected: RFC 8707 makes `resource` optional, so a server-side default (`/mcp`) would be friendlier.
- Fix: default it, or mark it **required** in the guest checkout snippet.

**F5. The MCP rate limit is documented differently from what the server sends.**
- Repro: any `/mcp` response has `ratelimit-limit: 60` and `ratelimit-policy: 60;w=30`, which is 60 requests per 30 s.
  The docs say "30 req/min/token".
- Fix: correct the docs, or the header.

**F6. Guests get a different tool set from the docs, and tool descriptions mention tools guests don't have.**
- Repro: `tools/list` with a guest token returns `get-product-details, search-products, buy-products,
  get-invoice-by-id, search_help_articles, get_help_article, list_help_articles`. The docs list
  `submit-prepayment-step, list-invoices, update-order` instead of the help tools. The `get-product-details`
  description says *"Bill-payment products need a bill_payment_id from submit-prepayment-step"*, and the `buy-products`
  description mentions `list-saved-fiat-cards`. Neither tool exists for a guest. The tool names also mix kebab-case
  and snake_case.
- Expected: descriptions match the tools that actually exist in the session.
- Fix: generate descriptions for each auth tier, publish the tool matrix (guest, OAuth user, API key), and pick one
  naming style.

### MCP tool results

**F7. Tool results are TOON text, with no `structuredContent` and no `outputSchema`.**
- Repro: `tools/call search-products {"query":"jio","country":"IN","intent":"x"}` returns
  `content[0].text = "categories[4]{count,highlighted,value}:\n  1,food,food\n…products[3]:\n  - _id: …"`.
  None of the 7 tools has `outputSchema`.
- Expected: TOON is fine for LLM tokens. But programmatic agents (and policy gates that must read the price
  *before* the LLM sees it) need typed data. The format isn't named anywhere in the MCP docs. We only recognised
  TOON by eye and added `@toon-format/toon`.
- Fix: also return `structuredContent` with an `outputSchema` (MCP 2025-06-18), or at least document "results are
  TOON vX" and offer `format: "json"`.

**F8. `search-products` requires `intent`, and the docs examples don't show it.**
- Repro: `tools/call search-products {"query":"jio","country":"IN"}` returns
  *"MCP error -32602: Input validation error: … expected string, received undefined at intent"*.
- Fix: default `intent` (it's "context only; does not change matching" per its own description), or add it to every
  docs example.

**F9. The `country` filter is case-sensitive and fails with a misleading "service unavailable" error.**
- Repro: `search-products {"query":"jio","country":"in","intent":"x"}`, or with `"country":"India"`, returns
  `error: Search service not available / code: SERVICE_UNAVAILABLE / status: search_unavailable`. `"IN"` works.
- Expected: either upper-case the input, or return an INVALID_ARGUMENT error that names the expected ISO alpha-2 format.
  "Service unavailable" makes an agent retry or give up, and it made us think the API was down.
- Fix: normalise the case, and add `pattern: ^[A-Z]{2}$` (or an enum) to the schema. Our client now upper-cases.

**F10. Full-text search misses obvious matches.**
- Repro (country IN):
  - `"amazon"` returns 3 products, including `amazon-shopping-vouchers-india`.
  - `"amazon india"` returns 2, and **drops** `amazon-shopping-vouchers-india`, even though its name is
    "Amazon.in Shopping India".
  - `"amazon pay"` returns only Fresh and Prime. There's no Amazon Pay gift card, which is the most useful Indian card
    since it works on Swiggy and Zomato.
  - Global `"test"` returns 24 US restaurants (apparently stemming to "rest…").
  - `"jio recharge"` returns 2 products instead of 3 for `"jio"`.
- Expected: agents phrase queries the way users speak ("amazon india", "jio recharge").
- Fix: drop country words and generic words ("recharge", "gift card") from the query when `country` is set, and use
  OR/ranking rather than AND. Add aliases such as "amazon pay".

**F11. A dead cross-link inside product data.**
- Repro: the `get-product-details amazon-shopping-vouchers-india` description links to "our Amazon Pay product" at
  `/gift-cards/amazon_in-india/`. Then `get-product-details {"product_id":"amazon_in-india"}` returns
  `RESOURCE_NOT_FOUND`, and the suggestions are Amazon Poland and others.
- Fix: repair the link or the slug. An agent following the catalog's own advice hits a dead end.

**F12. Jio packages give no INR face value, only a USD price.**
- Repro: `get-product-details reliance-jio-india-bundles` returns 50 packages. Their `package_value` is a free-text
  plan name ("2GB/Day 5G Plan – 84 Days"), with `package_currency: INR` but **no INR amount**. Only the USD
  `payment_price` is there.
- Expected: users say "recharge ₹239 Jio". An agent can't match that, or show the INR price, without scraping names.
- Fix: add structured `face_value` (INR), `validity_days` and `data_per_day_gb` fields to each package.

### Test and sandbox

**F13. Guests can't see test products, so there's no end-to-end MCP purchase test without an account.**
- Repro: `get-product-details {"product_id":"test-gift-card-code"}` with a guest token returns
  `RESOURCE_NOT_FOUND`, with the suggestion "test-kitchen-philippines". The `-syldavia` set needs manual enablement by
  a Bitrefill contact (partner guide).
- Expected: a hackathon team (and any wallet integrator) should be able to run `buy-products` and get a delivered test
  code with zero human steps. That's the core demo.
- Fix: make `test-*` products visible to every token, auto-confirm them for any payment method, and never charge. Or
  offer `https://api.bitrefill.com/mcp?sandbox=1`. For events, a self-serve "hackathon mode" toggle on the developer
  page.

**F14. The test products doc doesn't list valid values or packages.** *(docs)*
- Repro: `docs/test-products.md` lists slugs but not which `value`s or `package_id`s each accepts. We copied `value: 10`
  from the OpenAPI example.
- Fix: add a column per product (for example "value 10–100 USD step 10").

### REST v2 reference *(docs; not live-verified, no key)*

**F15. The OpenAPI schemas contradict the guides.**
- `POST /invoices` `products` is typed `object`, but every example sends an **array**.
- `package_id` is typed `number`, but the quickstart sends `"amazon-us<&>50"` and Product `packages[].id` is
  `"test-gift-card-link<&>10"`, both strings.
- Product `packages` is typed `object`, not array. `packages.value` is typed `string`, with numeric example `10`.
- Order `redemption_info` is typed **string** (a prose example), while guides read `redemption_info.code` and
  `.instructions`. Our mapper has to handle both.
- `_href` examples point to `https://api-bitrefill.com/2/products/...`, which has the wrong domain and `2` instead of
  `v2`.
- Fix: run a schema linter against real responses. Generated clients (openapi-typescript and similar) currently produce
  wrong types.

**F16. Invoice and order status values aren't enumerated.** *(docs)*
- Repro: Invoice `status` example is `"not_delivered"` and payment `status` is `"unpaid"`, with no enum anywhere. Our
  normaliser had to guess (`unpaid / payment_detected / paid / complete / all_delivered / denied / payment_error /
  expired …`).
- Fix: publish the state machine (an enum plus a diagram). It matters most for agents that must not report "paid"
  wrongly.

**F17. Webhooks are documented, but `webhook_url` is missing from the `POST /invoices` schema.** *(docs)*
- Fix: add the property, and the exact payload schema, to the reference.

**F18. `/v2/products/search` has no `country` filter, although MCP `search-products` does.** *(docs)*
- Effect: v2 users filter client-side and page through global results (max 50 per page) against a product quota.
- Fix: add `country`, `category` and `product_type` query params to match MCP.

**F19. Error formats differ across surfaces.**
- Repro: `GET /v2/ping` with no token returns JSON `{"message":"Authorization token not found","status":"no_token"}`.
  `POST /mcp` with no token returns `text/plain` "Unauthorized". `/.well-known/*` 404s return an HTML "Cannot GET".
- Fix: return JSON errors everywhere. For MCP, use the JSON-RPC error envelope even on 401.

### Payments, ZEC and agents

**F20. There's no ZEC payment method.**
- Repro: the `payment_methods.address_based` list for Jio Bundles has 24 methods, including dash, dogecoin, ton and
  ark, but **no zcash**.
- Context: Zcash World Mumbai is running "shielded-ZEC-only" this week. We had to bridge ZEC to USDC-Base through
  NEAR Intents 1Click (`nep141:zec.omft.near` to `nep141:base-0x8335…2913.omft.near`).
- Fix: native `zcash` (transparent is enough to start; 1Click and SideShift can then source it from shielded), or an
  official "pay with any asset via 1Click into `usdc_base`" recipe in the docs.

**F21. Invoice expiry versus bridged payments.**
- Repro: a 1Click dry quote ZEC to USDC-Base reports `timeEstimate: 459` s after the deposit confirms, and ZEC blocks
  take about 75 s. Bitrefill crypto invoices lock price for about 15 min.
- Effect: shielded ZEC, then a swap, then an invoice address is feasible but tight, and an underpayment from swap
  slippage risks a stuck invoice.
- Fix: a documented underpayment tolerance (for example 1%), or an `expires_in` option on invoice creation for bridged
  flows.

**F22. MCP `initialize.instructions` tells the agent to fetch a remote SKILL.md before purchasing.**
- Repro: `initialize` returns `"instructions":"…read https://www.bitrefill.com/agents/SKILL.md before the first purchase…"`.
- Concern: autonomous agents fetching and following remote instructions at runtime is a prompt-injection surface, and it
  can change without notice under a pinned integration.
- Fix: inline the safeguards, or publish a versioned and hashed URL that agents can pin.

---

## Adjacent: NEAR Intents 1Click (the ZEC leg), for anyone repeating this

- Native ZEC's asset id is `nep141:zec.omft.near`, not `zec:ZEC` as some third-party skill docs claim. Check
  `GET https://1click.chaindefuser.com/v0/tokens`.
- `refundTo` must be a **mainnet** ZEC address. Testnet `tm…` and junk return 400 "refundTo is not valid".
- The Base burn address `0x…dEaD` as `recipient` returns 400 "recipient is not valid".
- A dry quote (`dry:true`) needs no key or JWT and returns 201 with no `depositAddress` and no quote id; use
  `correlationId` as the reference. The schema and examples are at `https://1click.chaindefuser.com/docs/v0/openapi.yaml`.
