// Deterministic parser for scripted mode (the LLM does this itself in llm mode).

export interface ParsedRequest {
  amountInr: number | null;
  phone: string | null;
  brand: string | null;
  category: "mobile_topup" | "gift_card";
  query: string;
  recipientNote: string | null;
}

const TOPUP_BRANDS: Array<[RegExp, string]> = [
  [/\bjio\b/i, "Jio"],
  [/\bairtel\b/i, "Airtel"],
  [/\b(vi|vodafone|idea)\b/i, "Vi"],
  [/\bbsnl\b/i, "BSNL"],
];
const GIFT_BRANDS: Array<[RegExp, string]> = [
  [/amazon(\s*pay)?/i, "Amazon Pay"],
  [/flipkart/i, "Flipkart"],
  [/swiggy/i, "Swiggy"],
  [/zomato/i, "Zomato"],
  [/myntra/i, "Myntra"],
  [/uber/i, "Uber"],
  [/google\s*play/i, "Google Play"],
];

export function parseIndianAmount(s: string): number | null {
  // ₹239, Rs. 239, Rs 1,000, INR 500, 500 rupees, 239/-
  const pats = [
    /(?:₹|\brs\.?|\binr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:rupees?|rs\.?|inr|₹|\/-)/i,
  ];
  for (const p of pats) {
    const m = p.exec(s);
    if (m) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

export function parseIndianPhone(s: string): string | null {
  // +91 98765 43210, +91-9876543210, 09876543210, 9876543210
  const m = /(?:\+?91[\s-]?|\b0)?([6-9][0-9]{4})[\s-]?([0-9]{5})\b/.exec(s);
  return m ? `+91${m[1]}${m[2]}` : null;
}

export function parseRequest(prompt: string): ParsedRequest {
  const amountInr = parseIndianAmount(prompt);
  const phone = parseIndianPhone(prompt);
  let brand: string | null = null;
  let category: ParsedRequest["category"] = "gift_card";
  for (const [re, name] of TOPUP_BRANDS) if (re.test(prompt)) { brand = name; category = "mobile_topup"; break; }
  if (!brand) for (const [re, name] of GIFT_BRANDS) if (re.test(prompt)) { brand = name; category = "gift_card"; break; }
  if (!brand && (phone || /recharge|top.?up|prepaid/i.test(prompt))) category = "mobile_topup";
  const forM = /\bfor\s+(my\s+\w+|\w+)\b/i.exec(prompt);
  // Bitrefill lists Amazon India cards as "Amazon Shopping Vouchers India"; "Amazon" finds them.
  const query = brand === "Amazon Pay" ? "Amazon" : brand ?? (category === "mobile_topup" ? "India mobile recharge" : "India gift card");
  return { amountInr, phone, brand, category, query, recipientNote: forM ? forM[1]! : null };
}
