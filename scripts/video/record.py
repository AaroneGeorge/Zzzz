# Automated screen capture of the real ZecRecharge web flow (no human recording).
# Drives the UI with Playwright and saves JPEG frames + a timing/event log.
#   pw/bin/python -I scripts/video/record.py <base_url> <out_dir>
# Frames: <out_dir>/frames/f00000.jpg ... ; log: <out_dir>/events.json
import asyncio, json, os, sys, time

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3077/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "./rec"
FPS = 5
OPENING = sys.argv[3] if len(sys.argv) > 3 else None   # typed opening request (default: the ₹239 Jio preset)
os.makedirs(f"{OUT}/frames", exist_ok=True)

from playwright.async_api import async_playwright

T0 = time.monotonic()
now = lambda: round(time.monotonic() - T0, 3)
frames, events = [], []
state = {"page": None, "stop": False}
txids = []


def ev(name, **kw):
    e = {"t": now(), "name": name, **kw}
    events.append(e)
    print(json.dumps(e), flush=True)


CURSOR_JS = r"""
(() => {
  const install = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div'); c.id = '__cur';
    c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
      'border:3px solid #fff;background:rgba(244,183,40,.55);box-shadow:0 0 0 2px #000a,0 2px 10px #000a;z-index:2147483647;pointer-events:none;transition:transform .15s';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.6)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
"""


async def capture():
    i = 0
    while not state["stop"]:
        t = now()
        pg = state["page"]
        try:
            path = f"{OUT}/frames/f{i:05d}.jpg"
            await pg.screenshot(path=path, type="jpeg", quality=88, timeout=5000)
            frames.append({"t": t, "f": os.path.basename(path)})
            i += 1
        except Exception as e:  # page switching / navigation
            pass
        dt = 1 / FPS - (now() - t)
        if dt > 0:
            await asyncio.sleep(dt)


async def move_click(pg, sel, pause=0.6, click=True):
    loc = pg.locator(sel).first
    await loc.scroll_into_view_if_needed()
    box = await loc.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    await pg.mouse.move(x, y, steps=18)
    await asyncio.sleep(pause)
    if click:
        await pg.mouse.down(); await asyncio.sleep(0.12); await pg.mouse.up()  # a real click at the cursor


async def run_state(pg):
    return await pg.evaluate("current ? {id: current.id, status: current.status, finished: !!current.finishedAt, steps: current.steps.map(s => ({name: s.name, status: s.status, mode: s.detail && s.detail.mode, ids: s.detail && s.detail.ids, summary: s.detail && s.detail.summary}))} : null")


async def follow(pg, tag, until, timeout=420, prev_id=None):
    """Follow a run, auto-scroll to the active step, log every step transition."""
    seen, last_target, t_end = {}, None, time.monotonic() + timeout
    while time.monotonic() < t_end:
        st = await run_state(pg)
        if st and st["id"] != prev_id:
            for i, s in enumerate(st["steps"]):
                key = (i, s["status"])
                if seen.get(i) != s["status"]:
                    seen[i] = s["status"]
                    ev(f"{tag}_step", idx=i + 1, step=s["name"], status=s["status"], mode=s["mode"])
                    if s["ids"] and s["ids"].get("txid") and s["ids"]["txid"] not in txids:
                        txids.append(s["ids"]["txid"]); ev(f"{tag}_txid", txid=s["ids"]["txid"])
            if seen.get("run") != st["status"]:
                seen["run"] = st["status"]; ev(f"{tag}_status", status=st["status"])
            if st["status"] != "waiting_human":
                active = [i for i, s in enumerate(st["steps"]) if s["status"] not in ("pending",)]
                tgt = active[-1] if active else 0
                if tgt != last_target:
                    last_target = tgt
                    await pg.evaluate(f"(() => {{ const el = document.querySelectorAll('.step')[{tgt}]; if (el) el.scrollIntoView({{block: 'center', behavior: 'smooth'}}); }})()")
            if until(st):
                return st
        await asyncio.sleep(0.5)
    ev(f"{tag}_timeout")
    return await run_state(pg)


async def submit_preset(pg, label):
    st = await run_state(pg)
    prev = st and st["id"]
    await pg.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})"); await asyncio.sleep(1.0)
    await move_click(pg, f"#presets button:has-text('{label}')", pause=0.5)
    await asyncio.sleep(0.8)
    await move_click(pg, "#go", pause=0.5)
    return prev


async def submit_typed(pg, text):
    st = await run_state(pg)
    prev = st and st["id"]
    await move_click(pg, "#prompt", pause=0.4)
    await pg.keyboard.press("Control+A"); await pg.keyboard.press("Backspace")
    await pg.keyboard.type(text, delay=55)
    await asyncio.sleep(0.6)
    await move_click(pg, "#go", pause=0.5)
    return prev


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1920, "height": 1080},
                                  user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
        await ctx.add_init_script(CURSOR_JS)
        pg = await ctx.new_page()
        await pg.goto(BASE); await asyncio.sleep(1.5)
        await pg.mouse.move(700, 600)
        state["page"] = pg
        cap = asyncio.create_task(capture())
        ev("home"); await asyncio.sleep(4)

        # 1) ₹239 Jio: auto-approved, full 7 steps, real testnet txid
        ev("jio_click")
        prev = await (submit_typed(pg, OPENING) if OPENING else submit_preset(pg, "₹239 Jio"))
        ev("jio_submitted")
        st = await follow(pg, "jio", lambda s: s["finished"], timeout=480, prev_id=prev)
        ev("jio_done", status=st and st["status"])
        ev("jio_final", run=st)
        await asyncio.sleep(3)
        # show step 5 with the explorer link, then open it in a new tab
        await pg.evaluate("document.querySelectorAll('.step')[4].scrollIntoView({block:'center', behavior:'smooth'})")
        await asyncio.sleep(2.5)
        link = pg.locator(".step >> nth=4 >> .links a").first
        if await link.count():
            ev("explorer_hover")
            await move_click(pg, ".step >> nth=4 >> .links a", pause=1.0, click=False)
            try:
                async with ctx.expect_page(timeout=15000) as np:
                    await link.click()
                ex = await np.value
                await ex.wait_for_load_state("domcontentloaded", timeout=30000)
                await asyncio.sleep(2.5)
                state["page"] = ex; ev("explorer_open", url=ex.url)
                await ex.mouse.move(1300, 210, steps=15)
                await asyncio.sleep(6)
                await ex.mouse.move(960, 650, steps=20)
                await asyncio.sleep(3)
                ev("explorer_close")
                state["page"] = pg
                await ex.close()
            except Exception as e:
                ev("explorer_failed", err=str(e)[:200]); state["page"] = pg
        await asyncio.sleep(1.5)

        # 2) ₹700 Amazon Pay: human Confirm
        ev("amz_click")
        prev = await submit_preset(pg, "₹700 Amazon Pay")
        ev("amz_submitted")
        st = await follow(pg, "amz", lambda s: s["status"] == "waiting_human" or s["finished"], timeout=240, prev_id=prev)
        if st and st["status"] == "waiting_human":
            await pg.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
            await asyncio.sleep(4)
            ev("amz_confirm_click")
            await move_click(pg, ".confirm .yes", pause=1.0)
            st = await follow(pg, "amz", lambda s: s["finished"], timeout=480)
        ev("amz_done", status=st and st["status"])
        ev("amz_final", run=st)
        await asyncio.sleep(2)
        sec = pg.locator(".secret").first
        if await sec.count():
            await sec.scroll_into_view_if_needed()
            await pg.evaluate("document.querySelector('.secret').scrollIntoView({block:'center', behavior:'smooth'})")
            await asyncio.sleep(2)
            ev("reveal_click")
            await move_click(pg, ".secret", pause=1.0)
            await asyncio.sleep(0.6)
            await pg.mouse.move(900, 1000, steps=12)
            await asyncio.sleep(4)
        else:
            ev("no_secret")
        await asyncio.sleep(1)

        # 3) ₹1,500 Flipkart: denied by policy
        ev("fk_click")
        prev = await submit_preset(pg, "₹1,500 Flipkart")
        ev("fk_submitted")
        st = await follow(pg, "fk", lambda s: s["finished"], timeout=180, prev_id=prev)
        ev("fk_done", status=st and st["status"])
        await pg.evaluate("window.scrollTo({top: 0, behavior: 'smooth'})")
        await asyncio.sleep(6)
        await pg.mouse.move(1650, 200, steps=20)
        await asyncio.sleep(4)
        ev("end")
        state["stop"] = True
        await cap
        await pg.screenshot(path=f"{OUT}/final_full.png", full_page=True)
        await b.close()
    json.dump({"frames": frames, "events": events, "txids": txids}, open(f"{OUT}/events.json", "w"), indent=1)


asyncio.run(main())
