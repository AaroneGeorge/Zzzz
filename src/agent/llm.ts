// LLM mode: Claude drives the five tools. The tools themselves enforce the policy gate.
import Anthropic from "@anthropic-ai/sdk";
import type { AgentTools } from "./tools";

export const SYSTEM_PROMPT = `You are ZecRecharge, a shopping agent for people in India. You buy mobile recharges and gift cards on Bitrefill and pay from a shielded Zcash wallet.

Read the request: the amount in rupees (₹239, Rs 500, INR 1,000, "500 rupees"), an Indian phone number if any (+91 then 10 digits), and the brand. Jio, Airtel, Vi and BSNL recharges are category "mobile_topup"; Amazon Pay, Flipkart, Swiggy and other cards are "gift_card".

Call the tools one at a time, in this order:
1. search_products (query = the brand; for Amazon Pay use "Amazon")
2. request_approval with the recommended product_id, the rupee amount and the category
3. place_order with action "create"
4. quote_bridge
5. pay_shielded with the invoice_id
6. place_order with action "confirm"

A policy gate in code checks every payment and order; you cannot change or skip it. If approval is denied or rejected, stop and tell the user why. If the request has no rupee amount, do not guess: stop and ask for it. If a tool fails, report the error; never invent ids.
End with two or three short sentences: what was bought, the key ids, and each step's mode (real, test, quote, fixture, mock or manual). Never call a fixture, mock, test or quote a real payment.`;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description: "Search Bitrefill for an Indian product. Returns results and a recommended product_id to buy (in test/offline mode this is a free Bitrefill test product).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Brand or product, e.g. 'Jio' or 'Amazon Pay'" },
        category: { type: "string", enum: ["mobile_topup", "gift_card"] },
        amount_inr: { type: "number", description: "Requested amount in rupees" },
        phone: { type: "string", description: "Phone number for recharges, +91XXXXXXXXXX" },
      },
      required: ["query", "category"],
    },
  },
  {
    name: "request_approval",
    description: "Ask the spending-policy gate to approve a purchase. May wait for a human click when the amount is above the auto-approve limit.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        amount_inr: { type: "number" },
        category: { type: "string", enum: ["mobile_topup", "gift_card"] },
        merchant: { type: "string", description: "Always 'bitrefill'" },
        phone: { type: "string" },
        reason: { type: "string", description: "One line on why the user wants this" },
      },
      required: ["product_id", "amount_inr", "category"],
    },
  },
  {
    name: "place_order",
    description: "action 'create': create the Bitrefill invoice for the approved product. action 'confirm': after payment, fetch the order and its delivery.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "confirm"] },
        product_id: { type: "string" },
        invoice_id: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "quote_bridge",
    description: "Get a NEAR Intents 1Click quote for swapping ZEC to USDC on Base for the approved amount. Quote only; nothing is swapped.",
    input_schema: {
      type: "object",
      properties: { amount_inr: { type: "number" } },
      required: [],
    },
  },
  {
    name: "pay_shielded",
    description: "Send the shielded Zcash payment for the invoice. The memo ZR1|<invoice_id>|<policy_hash8> is set by code.",
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string" } },
      required: ["invoice_id"],
    },
  },
];

type CreateFn = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; [k: string]: unknown }>;
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}>;

export interface LlmClientLike {
  beta: { messages: { create: CreateFn } };
}

export async function runLlmLoop(tools: AgentTools, prompt: string, client?: LlmClientLike): Promise<void> {
  const c = client ?? (new Anthropic() as unknown as LlmClientLike);
  const cfg = tools.cfg;
  const run = tools.run;
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: prompt }];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let turn = 0; turn < cfg.maxLlmTurns; turn++) {
    const res = await c.beta.messages.create({
      model: cfg.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: "low" },
      // Server-side refusal fallback (Claude API only).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });
    tokensIn += res.usage?.input_tokens ?? 0;
    tokensOut += res.usage?.output_tokens ?? 0;
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && typeof b.text === "string" && b.text.trim()) run.notes.push(b.text.trim());
    tools.emit();

    if (res.stop_reason === "refusal") {
      run.notes.push("The model declined this request.");
      break;
    }
    if (res.stop_reason !== "tool_use") break;

    const results: unknown[] = [];
    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      const name = String(b.name);
      const input = (b.input ?? {}) as Record<string, unknown>;
      let content: string;
      let isError = false;
      try {
        content = JSON.stringify(await dispatch(tools, name, input));
      } catch (e) {
        isError = true;
        content = (e as Error).message;
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    if (run.status === "denied" || run.status === "rejected") {
      // Let the model write its one-line explanation, then stop (no further tools are useful).
      cfg.maxLlmTurns = Math.min(cfg.maxLlmTurns, turn + 2);
    }
  }
  run.notes.push(`[llm] model=${cfg.model} tokens in=${tokensIn} out=${tokensOut}`);
}

export async function dispatch(tools: AgentTools, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "search_products":
      return tools.search_products(input as Parameters<AgentTools["search_products"]>[0]);
    case "request_approval":
      return tools.request_approval(input as Parameters<AgentTools["request_approval"]>[0]);
    case "place_order":
      return tools.place_order(input as Parameters<AgentTools["place_order"]>[0]);
    case "quote_bridge":
      return tools.quote_bridge(input as Parameters<AgentTools["quote_bridge"]>[0]);
    case "pay_shielded":
      return tools.pay_shielded(input as Parameters<AgentTools["pay_shielded"]>[0]);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
