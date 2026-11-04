# Render the title / problem / end cards (1920x1080 JPEG) with headless Chromium.
#   pw/bin/python -I scripts/video/cards.py <out_dir>
import sys, os
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

CSS = """
* { box-sizing: border-box; margin: 0; }
body { width: 1920px; height: 1080px; background: radial-gradient(1400px 700px at 15% -10%, #2a2150 0%, transparent 60%), #0b0d12;
  color: #e8ebf2; font-family: 'DejaVu Sans', sans-serif; display: flex; flex-direction: column; justify-content: center; padding: 0 160px; }
.logo { width: 110px; height: 110px; border-radius: 26px; background: #f4b728; color: #111; display: grid; place-items: center;
  font-weight: 900; font-size: 64px; box-shadow: 0 0 80px #f4b72866; margin-bottom: 44px; }
h1 { font-size: 92px; letter-spacing: -2px; line-height: 1.05; }
h1 span { color: #f4b728; }
h2 { font-size: 46px; color: #f4b728; margin-bottom: 34px; letter-spacing: -0.5px; }
p.sub { font-size: 38px; color: #aab2c5; margin-top: 30px; line-height: 1.35; }
ul { list-style: none; padding: 0; }
li { font-size: 37px; line-height: 1.38; margin: 0 0 22px; padding-left: 48px; position: relative; }
li::before { content: '›'; position: absolute; left: 6px; color: #f4b728; font-weight: 900; }
.tag { display: inline-block; font: 700 26px 'DejaVu Sans Mono', monospace; padding: 8px 18px; border-radius: 10px; color: #0b0d12; margin-right: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px 70px; }
.col h3 { font-size: 34px; margin-bottom: 18px; color: #f4b728; }
.col li { font-size: 27px; margin-bottom: 12px; padding-left: 36px; }
.foot { margin-top: 46px; font: 700 34px 'DejaVu Sans Mono', monospace; color: #e8ebf2; }
.foot small { display: block; font: 400 24px 'DejaVu Sans', sans-serif; color: #8b93a7; margin-top: 10px; }
"""

CARDS = {
 "card_title": """
<div class="logo">ⓩ</div>
<h1>ZecRecharge — <span>private money,<br>bounded agents</span></h1>
<p class="sub">An AI agent pays shielded Zcash to a viewing-key gateway;<br>only a verified payment unlocks the Bitrefill order —<br>inside a spending mandate it cannot override.</p>
<p class="sub" style="font-size:28px;color:#6b7387;margin-top:50px">Automated screen capture of the real web UI · Zcash testnet · Bitrefill test products</p>
""",
 "card_problem": """
<h2>The problem</h2>
<ul>
<li>Zcash has strong private rails — but almost no shop takes ZEC.</li>
<li>AI agents are starting to spend money, yet a prompt is not a limit:<br>agents need a budget they <b>cannot</b> talk their way out of.</li>
<li><b>ZecRecharge:</b> the agent pays a shielded invoice; a gateway verifies it with a
<b>view-only key</b>; only then is the Bitrefill order placed — all behind a policy gate enforced in code.</li>
</ul>
""",
 "card_who": """
<h2>Who it's for</h2>
<ul>
<li><b>Zcash holders</b> who want an AI agent to buy everyday Indian essentials —
<b>mobile recharges, gift cards</b> — privately, paying in shielded ZEC.</li>
<li>Without handing the agent <b>unlimited spending</b>: every purchase passes a mandate
enforced in code that the agent cannot override.</li>
</ul>
""",
 "card_guard": """
<h2>The guardrails, enforced in code</h2>
<ul>
<li>Max <b>₹1,000 per purchase</b> and <b>₹1,000 per day</b></li>
<li>Above <b>₹500</b>: nothing is paid until a <b>human clicks Confirm</b></li>
<li>Allow-list: <b>Bitrefill only</b> — no other merchant can be paid</li>
<li>No verified payment → no order</li>
</ul>
<p class="sub" style="font-size:30px;margin-top:40px">The agent can't prompt its way past them: the policy gate checks every request
before any invoice, payment or order, and logs it to an append-only ledger.</p>
""",
 "card_end": """
<h2 style="margin-top:-40px">Real vs labelled — what you just saw</h2>
<div class="grid">
 <div class="col"><h3>Real</h3><ul>
  <li>Live Bitrefill product search (API v2)</li>
  <li>Policy gate + append-only ledger, in code</li>
  <li>Shielded <b>testnet</b> Zcash payments (TAZ, not ZEC)</li>
  <li>Gateway verification with a view-only UFVK wallet</li>
  <li>Bitrefill API orders of free <b>TEST products</b></li>
 </ul></div>
 <div class="col"><h3>Labelled, not real</h3><ul>
  <li>ZEC → USDC: NEAR Intents dry <b>quote</b>, nothing swapped</li>
  <li>No mainnet funds; no real recharge or gift card bought</li>
  <li>Testnet amount is a stand-in for the quoted ZEC</li>
  <li>Every step carries its badge: real · test · quote · fixture · mock · manual</li>
 </ul></div>
</div>
<p class="sub" style="font-size:28px;margin-top:40px">Stack: Bun + TypeScript · Claude agent (tool use) · zingo-cli (Zcash Orchard, testnet) · UFVK gateway · Bitrefill API · NEAR Intents 1Click</p>
<p class="sub" style="font-size:30px;margin-top:26px;color:#e8ebf2"><b>Testnet only. Orders are free test products. No mainnet payment.</b><br>Next: mainnet settlement + Telegram.</p>
<div class="foot">github.com/AaroneGeorge/Zzzz<small>ZecRecharge — private money, bounded agents</small></div>
""",
}

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1920, "height": 1080})
    for name, body in CARDS.items():
        pg.set_content(f"<html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{body}</body></html>")
        pg.wait_for_timeout(300)
        pg.screenshot(path=f"{OUT}/{name}.jpg", type="jpeg", quality=92)
        pg.screenshot(path=f"{OUT}/{name}.png")
    b.close()
print("ok")
