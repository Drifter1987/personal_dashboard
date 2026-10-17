#!/usr/bin/env python3
"""The browser contract for the dashboard's card interactions.

    python _ui.test.py            run every case, exit 1 on the first failure
    python _ui.test.py -v         also print each measurement

Why this file exists next to _check.mjs: that harness reads the sources and the Worker, so it
can prove a button is wired and a phrase is translated, but it cannot see layout. The scroll
jump this file is named for was invisible to 262 passing source checks, because the bug lived
in what the browser does with a height that is briefly zero. These cases drive the real page in
Chromium and assert what a person would notice: an interaction must not move the page, a section
change must start at the top, and the calendar's Today button must rest on the month you are in.

Every case runs in a fresh browser context, so saved settings are never shared between cases and
nothing here can touch the machine's own profile. External hosts are blocked: the contract is
about layout, and a weather card that arrives mid-measurement would only add flake.
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERBOSE = "-v" in sys.argv

# A card above the fold is hidden from its own header, which is itself off-screen, so the click
# is dispatched in the page: a Playwright click would scroll the header into view first and move
# the very thing being measured. Returns the next card's position before the hide.
HIDE_TOP_CARD = (
    "(() => {const e=document.querySelector('.topbar').getBoundingClientRect().bottom;"
    "const cards=[...document.querySelectorAll('.page.active [data-widget]')];"
    "const first=cards.find(n=>n.getBoundingClientRect().bottom>e);"
    "const next=cards[cards.indexOf(first)+1];"
    "if(!first||!next)return null;"
    "const top=Math.round(next.getBoundingClientRect().top);"
    "first.querySelectorAll('h2 .wctl').forEach(b=>{if(b.textContent==='Hide')b.click()});"
    "return {first:first.dataset.widget, next:next.dataset.widget, top:top}})()"
)

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + detail) if detail else ""))
    return ok


def serve():
    """A static server on a free loopback port, so a case never depends on a running server."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def log_message(self, *a):
            pass

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), Quiet)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, "http://127.0.0.1:%d/index.html" % port


def boot(browser, base, width, height, tasks=0):
    ctx = browser.new_context(viewport={"width": width, "height": height})
    page = ctx.new_page()
    # only this machine answers: a card waiting on the network cannot move the measurements
    page.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base.rsplit("/", 1)[0]) else r.abort())
    if tasks:
        # a page long enough that removing a card above the fold still leaves a reachable offset
        seeded = [{"id": "t%d" % i, "text": "Seeded task %d" % i, "done": False, "due": "", "status": "todo"}
                  for i in range(tasks)]
        page.add_init_script("localStorage.setItem('pd_tasks', %s)" % json.dumps(json.dumps(seeded)))
    page.goto(base)
    page.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
    page.add_style_tag(content="*,*::before,*::after{transition:none!important;animation:none!important}")
    return ctx, page


# ---- measurements the cases share ------------------------------------------------------------
def y(page):
    return page.evaluate("Math.round(scrollY)")


def tops(page):
    return page.evaluate(
        "Object.fromEntries([...document.querySelectorAll('.page.active [data-widget]')]"
        ".map(n=>[n.dataset.widget, Math.round(n.getBoundingClientRect().top)]))"
    )


def card(page, wid):
    return page.locator("#w_%s" % wid)


def header_button(page, wid, label):
    return card(page, wid).locator("h2 button", has_text=label).first


def wait_for(page, expr, want, limit=1500):
    """A bare wait: layout settles on the next frame, and a smooth scroll takes a few."""
    page.wait_for_function("() => " + expr + " === " + str(want), timeout=limit)


def click_in_view(page, locator, settle=250):
    """Click without letting the harness's own scroll-into-view pollute the measurement.

    Playwright scrolls a control into view before clicking it, so the offset has to be read
    after that scroll and before the click: otherwise the case measures the harness moving the
    page and calls it the app's fault.
    """
    locator.scroll_into_view_if_needed()
    page.wait_for_timeout(80)
    before = y(page)
    locator.click()
    page.wait_for_timeout(settle)
    return before


def cases(browser, base):
    # ── 1. a rebuild is not navigation ────────────────────────────────────────────────────────
    def rebuild_keeps_offset():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.locator('details[data-set="cards"] > summary').click()
            page.evaluate("scrollTo(0, 600)")
            page.wait_for_timeout(120)
            before = y(page)
            if not check("contract: the Settings page is long enough to be scrolled", before >= 600, "y=" + str(before)):
                return
            # dispatched in the page, at a controlled offset: a harness click would scroll first
            page.evaluate("document.querySelector('.cchip[data-widget=\"clock\"]').click()")
            page.wait_for_timeout(250)
            check("a card turned off does not move the page", abs(y(page) - before) <= 2,
                  "y %d -> %d" % (before, y(page)))
            check("…and leaves the reader on the same section", page.evaluate("curPage") == 5,
                  "section " + str(page.evaluate("curPage")))
        finally:
            ctx.close()

    # ── 2. reordering is not navigation either ───────────────────────────────────────────────
    def reorder_keeps_offset():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(3); setEditing(true)")
            wait_for(page, "curPage", 3)
            page.evaluate("scrollTo(0, 99999)")
            page.wait_for_timeout(120)
            before = y(page)
            if not check("contract: the Planner page can be scrolled", before >= 60, "y=" + str(before)):
                return
            # same reason as the chip: dispatched in the page so no scroll-into-view precedes it
            page.evaluate("[...document.querySelectorAll('#w_cal h2 .wctl')].find(b=>b.textContent==='↓').click()")
            page.wait_for_timeout(300)
            check("moving a card down does not jump to the top of the page", abs(y(page) - before) <= 2,
                  "y %d -> %d" % (before, y(page)))
        finally:
            ctx.close()

    # ── 3a. hiding a card above the fold must not move the card you were reading ────────────
    def hiding_a_card_above_holds_the_card_below():
        ctx, page = boot(browser, base, 941, 620, tasks=24)
        try:
            page.evaluate("goPage(3); setEditing(true)")
            wait_for(page, "curPage", 3)
            page.evaluate("scrollTo(0, 900)")
            page.wait_for_timeout(150)
            before = y(page)
            info = page.evaluate(HIDE_TOP_CARD)
            page.wait_for_timeout(300)
            max_after = page.evaluate("document.documentElement.scrollHeight-innerHeight")
            after = y(page)
            next_top = page.evaluate(
                "(() => {const n=document.getElementById('w_%s');"
                "return n?Math.round(n.getBoundingClientRect().top):null})()" % (info or {}).get("next", "-")
            )
            ok = check(
                "a card hidden above the fold leaves the offset exactly where it was",
                bool(info) and before < max_after and after == before,
                "y %d -> %d (page max %d)" % (before, after, max_after))
            check("\u2026and the card under it does not move on screen",
                  ok and next_top is not None and abs(next_top - info["top"]) <= 2,
                  "next card top %s -> %s" % (info and info["top"], next_top))
        finally:
            ctx.close()

    # ── 3b. boundary: a page that became shorter than the offset can only clamp ─────────────
    def shortening_page_clamps_but_never_snaps_to_the_top():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(0); setEditing(true)")
            wait_for(page, "curPage", 0)
            page.evaluate("scrollTo(0, 260)")
            page.wait_for_timeout(150)
            before = y(page)
            page.evaluate(HIDE_TOP_CARD)
            page.wait_for_timeout(300)
            max_after = page.evaluate("document.documentElement.scrollHeight-innerHeight")
            after = y(page)
            check("when the page gets shorter than the offset, it clamps instead of snapping to the top",
                  after == min(before, max_after) and (max_after < before or after == before),
                  "y %d -> %d (page max %d)" % (before, after, max_after))
        finally:
            ctx.close()

    # ── 4. changing section is navigation, and does start at the top ─────────────────────────
    def section_change_starts_at_the_top():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.evaluate("scrollTo(0, 500)")
            page.wait_for_timeout(120)
            scrolled = y(page)
            if not check("contract: there is somewhere to scroll before changing section", scrolled > 100,
                         "y=" + str(scrolled)):
                return
            page.locator("#tabbar button").nth(0).click()
            wait_for(page, "Math.round(scrollY)", 0, 2500)
            check("changing section still opens it at the top", y(page) == 0, "y 0")
        finally:
            ctx.close()

    # ── 5. the phone's pager is a second scroller, and it survives a rebuild ─────────────────
    def phone_keeps_section_and_offset():
        ctx, page = boot(browser, base, 420, 800)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            left = page.evaluate("Math.round(document.getElementById('pages').scrollLeft)")
            page.locator('details[data-set="cards"] > summary').click()
            page.evaluate("scrollTo(0, 600)")
            page.wait_for_timeout(150)
            before = y(page)
            page.evaluate("document.querySelector('.cchip[data-widget=\"weather\"]').click()")
            page.wait_for_timeout(300)
            check("on a phone, turning a card off keeps the section and the vertical offset",
                  page.evaluate("curPage") == 5 and abs(y(page) - before) <= 2
                  and abs(page.evaluate("Math.round(document.getElementById('pages').scrollLeft)") - left) <= 2,
                  "section %s · y %d -> %d · x %d -> %d" % (
                      page.evaluate("curPage"), before, y(page), left,
                      page.evaluate("Math.round(document.getElementById('pages').scrollLeft)")))
        finally:
            ctx.close()

    # ── 6. the simplification's licence: only the document and the pager ever scroll ────────
    def only_two_scrollers_exist():
        detail = []
        ok = True
        for width, height in ((360, 740), (420, 800), (700, 800), (941, 620)):
            ctx, page = boot(browser, base, width, height)
            try:
                for section in range(6):
                    page.evaluate("goPage(%d)" % section)
                    wait_for(page, "curPage", section)
                    bad = page.evaluate(
                        "[...document.querySelectorAll('.page')]"
                        ".filter(p=>p.scrollHeight>p.clientHeight+1).length"
                    )
                    pager = page.evaluate(
                        "(() => {const p=document.getElementById('pages');"
                        "return p.scrollHeight>p.clientHeight+1})()"
                    )
                    if bad or pager:
                        ok = False
                        detail.append("%dpx section %d: %s" % (
                            width, section,
                            ("%d page(s) scroll" % bad) if bad else "the pager scrolls vertically"))
            finally:
                ctx.close()
        check("only the document and the phone pager ever scroll, at any width", ok,
              "; ".join(detail) or "4 widths × 6 sections")

    # ── 7. a card that is loading keeps its frame ───────────────────────────────────────────
    def a_loading_card_keeps_its_frame():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(0)")
            wait_for(page, "curPage", 0)
            page.wait_for_timeout(300)
            r = page.evaluate(
                "(async () => {const bd=document.querySelector('#wb_quote');"
                "const before=Math.round(bd.getBoundingClientRect().height);"
                "bd.innerHTML='';await new Promise(r=>setTimeout(r,0));"
                "const held=Math.round(bd.getBoundingClientRect().height);"
                "bd.innerHTML='<div style=\"height:'+(before+80)+'px\"></div>';"
                "await new Promise(r=>setTimeout(r,150));"
                "return {before, held, after:Math.round(bd.getBoundingClientRect().height), min:bd.style.minHeight}})()"
            )
            check("an emptied card holds the height it had, so the page below does not move",
                  r["before"] > 10 and abs(r["held"] - r["before"]) <= 1,
                  "%dpx -> %dpx while loading" % (r["before"], r["held"]))
            check("\u2026and releases the frame once the new content is at least that tall",
                  r["after"] >= r["before"] + 70 and r["min"] == "",
                  "%dpx, min-height %r" % (r["after"], r["min"]))
        finally:
            ctx.close()

    # ── 8. opening the dashboard lands on Home, whatever you were reading ───────────────────
    def opening_lands_on_home():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.evaluate("scrollTo(0, 500)")
            page.wait_for_timeout(150)
            left_at = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            page.reload()
            page.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
            page.wait_for_timeout(200)
            now = page.evaluate("({p:curPage, y:Math.round(scrollY), q:location.search})")
            check("reopening the dashboard lands on Home, not the section you left",
                  left_at["p"] == 5 and now["p"] == 0 and now["y"] == 0 and now["q"] == "",
                  "left at section %d · reopened at %d, y=%d, url=%r" % (
                      left_at["p"], now["p"], now["y"], now["q"]))
        finally:
            ctx.close()

    # ── 9. a burst of app buttons leaves section and offset alone ───────────────────────────
    def buttons_do_not_move_the_view():
        ctx, page = boot(browser, base, 941, 620, tasks=24)
        try:
            page.evaluate("goPage(3)")
            wait_for(page, "curPage", 3)
            page.evaluate("scrollTo(0, 700)")
            page.wait_for_timeout(150)
            before = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            if not check("contract: the Planner page can be scrolled for the button sweep",
                         before["y"] >= 700, "y=" + str(before["y"])):
                return
            # Dispatched in the page so the harness cannot scroll first: the point of the case is
            # what the handler does to the view, not what a click does to reach the control.
            for label, js in (
                ("the theme button", "document.querySelector('#themeBtn').click()"),
                ("a card's refresh", "document.querySelector('#w_cal h2 .mini').click()"),
                ("a month arrow", "[...document.querySelectorAll('#w_cal button')].find(b=>b.textContent==='‹').click()"),
            ):
                before = {"p": page.evaluate("curPage"), "y": y(page)}
                page.evaluate(js)
                page.wait_for_timeout(300)
                if not check("a button press leaves the section and the offset alone (%s)" % label,
                             page.evaluate("curPage") == before["p"] and abs(y(page) - before["y"]) <= 2,
                             "section %s · y %d -> %d" % (before["p"], before["y"], y(page))):
                    return
        finally:
            ctx.close()

    # ── 10. the calendar's Today button still behaves ────────────────────────────────────────
    def today_button():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(3)")
            wait_for(page, "curPage", 3)
            btn = page.locator("#w_cal .todaybtn")
            month = page.evaluate("calCursor.getMonth()")
            check("Today rests disabled on the month you are in",
                  btn.is_disabled() and page.evaluate("document.querySelector('#w_cal .calToday')!==null"))
            page.locator("#w_cal .row button", has_text="‹").first.click()
            page.locator("#w_cal .row button", has_text="‹").first.click()
            check("…and offers a way back once you have left it", btn.is_enabled())
            btn.click()
            page.wait_for_timeout(150)
            check("one press returns to the current month and rests again",
                  page.evaluate("calCursor.getMonth()") == month and btn.is_disabled()
                  and page.evaluate("document.querySelector('#w_cal .calToday')!==null"))
        finally:
            ctx.close()

    return [rebuild_keeps_offset, reorder_keeps_offset, hiding_a_card_above_holds_the_card_below,
            shortening_page_clamps_but_never_snaps_to_the_top,
            section_change_starts_at_the_top, phone_keeps_section_and_offset,
            only_two_scrollers_exist, a_loading_card_keeps_its_frame, opening_lands_on_home,
            buttons_do_not_move_the_view, today_button]


def main():
    from playwright.sync_api import sync_playwright

    httpd, base = serve()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                for case in cases(browser, base):
                    try:
                        case()
                    except Exception as e:  # a thrown case is a failed case, never a skipped one
                        check(case.__name__, False, type(e).__name__ + ": " + str(e).splitlines()[0][:160])
            finally:
                browser.close()
    finally:
        httpd.shutdown()

    failed = [n for n, ok, _ in CHECKS if not ok]
    print("\n%d/%d checks passed" % (len(CHECKS) - len(failed), len(CHECKS)))
    if failed:
        print("FAILED: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
