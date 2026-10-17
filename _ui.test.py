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
# "Above the fold" is meant literally: the last card that ends before the sticky header. Picking
# the first card that merely reaches past it hid whatever was under the header instead, which is
# not the case this is named for.
HIDE_TOP_CARD = (
    "(() => {const e=document.querySelector('.topbar').getBoundingClientRect().bottom;"
    "const cards=[...document.querySelectorAll('.page.active [data-widget]')];"
    "const above=cards.filter(n=>n.getBoundingClientRect().bottom<=e);"
    "const first=above[above.length-1]||cards[0];"
    "const next=cards[cards.indexOf(first)+1];"
    "if(!first||!next)return null;"
    "const top=Math.round(next.getBoundingClientRect().top);"
    "first.querySelectorAll('h2 .wctl').forEach(b=>{if(b.textContent==='Hide')b.click()});"
    "return {first:first.dataset.widget, next:next.dataset.widget, top:top}})()"
)

CHECKS = []

# A card carrying three files, with the bytes in the page's own store. The viewer reads a file
# back from IndexedDB, so the seed has to put real bytes there; the canvas gives the case a known
# natural size to measure a crop against, and the spreadsheet is the one type that cannot be
# shown here at all.
SEED_FILES = """
async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('pd_files', 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', {keyPath: 'id'}); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const c = document.createElement('canvas'); c.width = 800; c.height = 520;
  const x = c.getContext('2d'); x.fillStyle = '#3aa'; x.fillRect(0, 0, 800, 520);
  x.fillStyle = '#fff'; x.font = '64px sans-serif'; x.fillText('INVOICE', 60, 280);
  const png = await new Promise(r => c.toBlob(r, 'image/png'));
  const txt = new Blob(['line one\\nline two\\n'], {type: 'text/plain'});
  const book = new Blob([new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0])], {type: 'application/vnd.ms-excel'});
  const put = (rec) => new Promise((res, rej) => {
    const t = db.transaction('files', 'readwrite');
    t.objectStore('files').put(rec); t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  await put({id: 'aSeed1', name: 'Q3 invoice.png', type: 'image/png', size: png.size, blob: png});
  await put({id: 'aSeed2', name: 'meeting notes.txt', type: 'text/plain', size: txt.size, blob: txt});
  await put({id: 'aSeed3', name: 'plan.xlsx', type: 'application/vnd.ms-excel', size: book.size, blob: book});
  tasks.push({id: 'tSeed1', text: 'Send the invoice pack', done: false, due: '', status: 'todo',
    att: [{id: 'aSeed1', name: 'Q3 invoice.png', type: 'image/png', size: png.size},
          {id: 'aSeed2', name: 'meeting notes.txt', type: 'text/plain', size: txt.size},
          {id: 'aSeed3', name: 'plan.xlsx', type: 'application/vnd.ms-excel', size: book.size}]});
  store.set('pd_tasks', tasks); renderTasks(true); renderTasks(false); renderKanban();
  return {png: png.size};
}
"""


def open_file(page, name):
    """Open one attachment of the seeded card, straight through the viewer's own entry point."""
    page.evaluate(
        "(() => {const c=tasks.find(x=>x.id==='tSeed1');const a=(c.att||[]).find(v=>v.name===%s);"
        "attView(c,a)})()" % json.dumps(name)
    )
    page.wait_for_selector("#viewBox h3", timeout=3000)


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


def boot(browser, base, width, height, tasks=0, clipboard=False):
    ctx = browser.new_context(viewport={"width": width, "height": height})
    if clipboard:
        # a clipboard needs permission even in a headless run, and "the copy holds the picture
        # you are looking at" is only worth asserting if the browser will hand it back
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    # only this machine answers: a card waiting on the network cannot move the measurements. A
    # blob: URL is excluded from the guard on purpose - that is the page's own file bytes coming
    # back out of IndexedDB, not an external host, and intercepting it makes every image fail.
    page.route(lambda url: not url.startswith("blob:"),
               lambda r: r.continue_() if r.request.url.startswith(base.rsplit("/", 1)[0]) else r.abort())
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


def settle(page, expr, quiet=250, limit=3000):
    """Wait until a value stops changing, and return it.

    A smooth scroll is not done when it has moved: it is done when it has stopped. Reading the
    pager the moment after goPage() saw 0 locally and 2100 on a slower runner, which made this
    contract report a bug that only existed in the harness's timing.
    """
    last = page.evaluate(expr)
    waited = 0
    while waited < limit:
        page.wait_for_timeout(quiet)
        waited += quiet
        now = page.evaluate(expr)
        if now == last:
            return now
        last = now
    return last


def click_text(page, scope, text):
    """Press a button by its label inside a scope, dispatched in the page.

    A pointer click would scroll the control into view first, which is noise for a case that is
    about what the control does. Returns True when a button with that exact label was found.
    """
    return page.evaluate(
        """([scope, text]) => {
          // painted, not merely un-hidden: a class of control here is '.' + 'mini' with its own
          // display, which quietly outranks the [hidden] attribute
          const b = [...document.querySelectorAll(scope + ' button')]
            .find(n => n.textContent === text && n.getClientRects().length);
          if (!b) return false;
          b.click();
          return true;
        }""",
        [scope, text],
    )


FOOT_VISIBLE = (
    "[...document.querySelectorAll('#viewBox .fvfoot button')]"
    ".filter(b=>b.getClientRects().length).map(b=>b.textContent)"
)


def clipboard_image(page):
    """What is on the clipboard, as pixels: size plus the top-left pixel's colour."""
    return page.evaluate(
        """async () => {
          const items = await navigator.clipboard.read();
          const type = items[0].types.find(s => s.indexOf('image/') === 0);
          if (!type) return null;
          const bmp = await createImageBitmap(await items[0].getType(type));
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0);
          const d = cx.getImageData(0, 0, 1, 1).data;
          return {type: type, w: bmp.width, h: bmp.height, px: [d[0], d[1], d[2]]};
        }"""
    )


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
            left = settle(page, "Math.round(document.getElementById('pages').scrollLeft)")
            if not check("contract: the phone pager actually reaches the last section", left > 0,
                         "x=" + str(left)):
                return
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

    # ── 6b. a card is only as tall as what it holds ────────────────────────────
    def a_card_is_only_as_tall_as_its_content():
        detail = []
        ok = True
        ctx, page = boot(browser, base, 941, 620)
        try:
            for section in range(6):
                page.evaluate("goPage(%d)" % section)
                wait_for(page, "curPage", section)
                page.wait_for_timeout(120)
                rows = page.evaluate(
                    "(() => [...document.querySelectorAll('.page.active .card[data-widget]')]"
                    ".map(c => {const b=c.querySelector('[id^=wb_]'), cs=getComputedStyle(c);"
                    "const inner=b.lastElementChild||b;"
                    "const end=inner.getBoundingClientRect().bottom;"
                    "return {id:c.dataset.widget,"
                    "slack:c.getBoundingClientRect().bottom-parseFloat(cs.paddingBottom)"
                    "-parseFloat(cs.borderBottomWidth)-end}}))()"
                )
                for row in rows:
                    # a line of block spacing (13px) is normal; a stretched card is hundreds
                    if row["slack"] > 24:
                        ok = False
                        detail.append("section %d %s: %.0fpx" % (section, row["id"], row["slack"]))
        finally:
            ctx.close()
        check("no card is taller than what it holds, so no card draws a border around nothing",
              ok, "; ".join(detail) or "6 sections · every card sized to its content")

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
            settle(page, "Math.round(scrollY)", quiet=120, limit=1200)
            now = page.evaluate("({p:curPage, y:Math.round(scrollY), q:location.search})")
            check("reopening the dashboard lands on Home, not the section you left",
                  left_at["p"] == 5 and now["p"] == 0 and now["y"] == 0 and now["q"] == "",
                  "left at section %d · reopened at %d, y=%d, url=%r" % (
                      left_at["p"], now["p"], now["y"], now["q"]))
            # Locally a reload happens to start at the top on its own; on the CI runner the
            # browser restored 351px of the old offset, which is how this was found. The offset
            # has to belong to the page, not to whether the restore won a race.
            rest = page.evaluate("history.scrollRestoration")
            check("\u2026and the offset belongs to the page, not to the browser's own restore",
                  rest == "manual", "history.scrollRestoration=%r" % rest)
        finally:
            ctx.close()

    # ── 8b. a link that names a section still opens it, at that section's top ───────────────
    def a_shortcut_link_opens_its_section():
        ctx, page = boot(browser, base + "?p=3", 941, 620)
        try:
            settle(page, "Math.round(scrollY)", quiet=120, limit=1200)
            now = page.evaluate("({p:curPage, y:Math.round(scrollY), q:location.search})")
            check("a shortcut link still opens the section it names, at its top",
                  now["p"] == 3 and now["y"] == 0 and now["q"] == "?p=3",
                  "section %s · y=%s · url=%r" % (now["p"], now["y"], now["q"]))
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

    # ── 11. a search suggestion lands on the word, and marks it for three seconds ───────────
    def search_suggestion_marks_the_word():
        ctx, page = boot(browser, base, 941, 620)
        try:
            # shut the group holding the word first: the point of the case is that landing on a
            # word opens what hides it, not that it happened to be open already
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.evaluate("(() => {const d=document.querySelector('details[data-set=\"look\"]');"
                          "if(d&&d.open)d.querySelector('summary').click()})()")
            page.wait_for_timeout(150)
            shut = page.evaluate("document.querySelector('details[data-set=\"look\"]').open")
            page.evaluate("goPage(0)")
            wait_for(page, "curPage", 0)
            page.fill("#search", "language")
            page.wait_for_selector("#searchResults button", timeout=3000)
            hit = page.evaluate(
                "(() => {const b=[...document.querySelectorAll('#searchResults button')]"
                ".find(x=>/settings/i.test(x.textContent));if(!b)return null;b.click();return b.textContent})()"
            )
            if not check("contract: a settings word in the search box offers a suggestion", bool(hit) and not shut,
                         "shut=%s · %s" % (shut, hit)):
                return
            page.wait_for_timeout(450)
            st = page.evaluate(
                "({p:curPage, mark:(document.querySelector('mark.hit')||{}).textContent||null,"
                " open:!!(document.querySelector('details[data-set=\"look\"]')||{}).open,"
                " word:(document.querySelector('mark.hit')||{}).getBoundingClientRect&&document.querySelector('mark.hit')?Math.round(document.querySelector('mark.hit').getBoundingClientRect().top):null})"
            )
            check("a suggestion opens the section that owns the word", st["p"] == 5,
                  "section %s (%s)" % (st["p"], hit))
            check("\u2026opens the group hiding it and marks the word itself",
                  st["open"] and (st["mark"] or "").lower() == "language",
                  "look open=%s · mark=%r" % (st["open"], st["mark"]))
            check("\u2026and the mark is on screen, not left off the bottom",
                  st["word"] is not None and -50 <= st["word"] <= 700, "mark top=%s" % st["word"])
            page.wait_for_timeout(3200)
            after = page.evaluate(
                "({mark:!!document.querySelector('mark.hit'),"
                " label:document.querySelector('#wb_settings').textContent.indexOf('Language') >= 0})"
            )
            check("\u2026and the mark is taken off again, leaving the label in place",
                  not after["mark"] and after["label"],
                  "mark gone=%s · label intact=%s" % (not after["mark"], after["label"]))
        finally:
            ctx.close()

    # ── 6. a file a card carries: findable by its name, and openable where it lives ───────────
    def a_file_name_is_a_search_result():
        ctx, page = boot(browser, base, 941, 760)
        try:
            if not check("contract: the card can be given files to open", bool(page.evaluate(SEED_FILES))):
                return
            page.fill("#search", "invoice")
            page.wait_for_selector("#searchResults button", timeout=3000)
            hit = page.evaluate(
                "(() => {const b=[...document.querySelectorAll('#searchResults button')]"
                ".find(x=>x.textContent.indexOf('Q3 invoice.png')>=0);if(!b)return null;b.click();return b.textContent})()"
            )
            check("a file's name is a search result, named with the card it belongs to",
                  bool(hit) and "Send the invoice pack" in hit, repr(hit))
            page.wait_for_selector("#fvImg", timeout=3000)
            st = page.evaluate(
                "({open:document.querySelector('#viewBack').classList.contains('open'),"
                " nw:document.querySelector('#fvImg').naturalWidth, page:curPage,"
                " bar:[...document.querySelectorAll('#viewBox .fvbar button')].map(b=>b.textContent)})"
            )
            check("pressing it opens the file in a viewer over the section that owns the card",
                  st["open"] and st["nw"] == 800 and st["page"] == 3,
                  "open=%s · %spx wide · section %s" % (st["open"], st["nw"], st["page"]))
            chips = [c for c in st["bar"] if c in ("Original", "Grey", "Sepia", "Warm", "Invert")]
            check("the viewer opens with zoom, Fit, Crop and the colour chips",
                  all(x in st["bar"] for x in ("\u2212", "+", "Fit", "Crop")) and len(chips) == 5,
                  " · ".join(st["bar"]))
            foot = page.evaluate(FOOT_VISIBLE)
            check("…and the crop's own two buttons stay off the bar until there is a crop",
                  "Save a copy" not in foot and "Original" not in foot and "Download" in foot,
                  " · ".join(foot))
            # the card's own list is the other door into a file, and it must not close under it
            page.evaluate("fvClose(); attModal(tasks.find(x=>x.id==='tSeed1'))")
            page.wait_for_selector("#attBody .attrow", timeout=3000)
            opened = page.evaluate(
                "(() => {const b=[...document.querySelectorAll('#attBody .attopen')]"
                ".find(n=>n.textContent==='meeting notes.txt');if(!b)return false;b.click();return true})()"
            )
            page.wait_for_selector("#fvPre", timeout=3000)
            both = page.evaluate(
                "({view:document.querySelector('#viewBack').classList.contains('open'),"
                " list:document.querySelector('#modalBack').classList.contains('open')})"
            )
            check("…and a file in the card's own list opens over it, leaving the list underneath",
                  opened and both["view"] and both["list"],
                  "opened=%s · viewer=%s · list still open=%s" % (opened, both["view"], both["list"]))
        finally:
            ctx.close()

    # ── 7. the four things a document photo needs: zoom, colour, crop, and a copy of it ───────
    def the_file_viewer_zooms_filters_crops_and_copies():
        ctx, page = boot(browser, base, 941, 760, clipboard=True)
        try:
            seeded = page.evaluate(SEED_FILES)
            open_file(page, "Q3 invoice.png")
            page.wait_for_function(
                "() => {const i=document.querySelector('#fvImg');return !!i && i.naturalWidth === 800}", timeout=3000)
            page.wait_for_timeout(150)
            w0 = page.evaluate("Math.round(document.querySelector('#fvImg').getBoundingClientRect().width)")
            click_text(page, "#viewBox .fvbar", "+")
            page.wait_for_timeout(150)
            w1 = page.evaluate("Math.round(document.querySelector('#fvImg').getBoundingClientRect().width)")
            lab = page.evaluate("document.querySelector('.fvzlab').textContent")
            # the picture opens fitted, so one press is a quarter again on top of the fit rather
            # than a jump to 125%: the label has to name the scale the picture actually has
            check("zoom in makes the picture bigger, and the label names the scale it is at",
                  w1 > w0 and 1.2 < w1 / w0 < 1.3 and lab == "%d%%" % round(w1 / 800 * 100),
                  "%dpx -> %dpx, and the label says %s" % (w0, w1, lab))
            click_text(page, "#viewBox .fvbar", "Grey")
            page.wait_for_timeout(120)
            filt = page.evaluate("getComputedStyle(document.querySelector('#fvImg')).filter")
            check("a colour chip filters the picture where it stands", "grayscale" in filt, filt)
            # a drag on the visible picture, applied at the file's own resolution
            armed = click_text(page, "#viewBox .fvbar", "Crop")
            page.wait_for_timeout(150)
            overlay = page.evaluate("!!document.querySelector('.fvcrop')")
            check("Crop arms a drag on the picture itself",
                  armed and overlay, "crop pressed=%s · overlay=%s" % (armed, overlay))
            box = page.locator("#fvStage").bounding_box()
            page.mouse.move(box["x"] + 40, box["y"] + 40)
            page.mouse.down()
            page.mouse.move(box["x"] + 200, box["y"] + 140, steps=6)
            page.mouse.up()
            page.wait_for_timeout(150)
            marked = page.evaluate("fvState.crop ? [Math.round(fvState.crop.w), Math.round(fvState.crop.h)] : null")
            applied = click_text(page, "#viewBox .fvbar", "Apply")
            if not check("…the drag picks 160x100 of the screen, and Apply takes it",
                         applied and marked == [160, 100], "drag=%s · applied=%s" % (marked, applied)):
                return
            page.wait_for_function(
                "() => {const i=document.querySelector('#fvImg');return !!i && i.naturalWidth < 800}", timeout=3000)
            page.wait_for_timeout(250)
            crop = page.evaluate(
                "({nw:document.querySelector('#fvImg').naturalWidth,"
                " nh:document.querySelector('#fvImg').naturalHeight,"
                " foot:" + FOOT_VISIBLE + "})"
            )
            check("a drag on the picture crops it, at full resolution rather than what is on screen",
                  100 < crop["nw"] < 800 and 80 < crop["nh"] < 520,
                  "160x100 of the screen came out %dx%d" % (crop["nw"], crop["nh"]))
            check("…and a crop offers a copy and a way back to the original",
                  "Save a copy" in crop["foot"] and "Original" in crop["foot"], " · ".join(crop["foot"]))
            click_text(page, "#viewBox .fvfoot", "Copy")
            page.wait_for_timeout(500)
            clip = clipboard_image(page)
            grey = clip and clip["px"][0] == clip["px"][1] == clip["px"][2]
            check("Copy takes the picture you are looking at - cropped, and in the grey it was filtered to",
                  bool(clip) and clip["w"] == crop["nw"] and clip["h"] == crop["nh"] and grey,
                  ("%s %dx%d pixel %s" % (clip["type"], clip["w"], clip["h"], clip["px"])) if clip else "nothing on the clipboard")
            click_text(page, "#viewBox .fvfoot", "Save a copy")
            page.wait_for_timeout(600)
            saved = page.evaluate(
                """async () => {
                  const c = tasks.find(x => x.id === 'tSeed1');
                  const rec = await fileGet('aSeed1');
                  const n = await new Promise(res => { const r = indexedDB.open('pd_files', 1);
                    r.onsuccess = () => { const q = r.result.transaction('files', 'readonly').objectStore('files').getAllKeys();
                      q.onsuccess = () => res(q.result.length); }; });
                  return {att: (c.att || []).length, keys: n, orig: rec.blob.size, name: c.att[c.att.length - 1].name};
                }"""
            )
            check("a crop can be kept as a copy on the card, and the file it came from is untouched",
                  saved["att"] == 4 and saved["keys"] == 4 and saved["orig"] == seeded["png"],
                  "4th file %r · %d records in the store · original still %d bytes"
                  % (saved["name"], saved["keys"], saved["orig"]))
        finally:
            ctx.close()

    # ── 8. the other two kinds of file, and the two honest failures ────────────────────────────
    def the_file_viewer_shows_text_and_says_what_it_cannot_show():
        ctx, page = boot(browser, base, 941, 760, clipboard=True)
        try:
            page.evaluate(SEED_FILES)
            open_file(page, "meeting notes.txt")
            page.wait_for_selector("#fvPre", timeout=3000)
            f0 = page.evaluate("parseFloat(getComputedStyle(document.querySelector('#fvPre')).fontSize)")
            click_text(page, "#viewBox .fvbar", "+")
            page.wait_for_timeout(150)
            f1 = page.evaluate("parseFloat(getComputedStyle(document.querySelector('#fvPre')).fontSize)")
            words = page.evaluate("document.querySelector('#fvPre').textContent")
            check("a text file opens as its own words, and zoom is the size of its type",
                  f1 > f0 and words.splitlines()[0] == "line one", "%.1fpx -> %.1fpx · %r" % (f0, f1, words))
            click_text(page, "#viewBox .fvfoot", "Copy")
            page.wait_for_timeout(400)
            got = page.evaluate("navigator.clipboard.readText()")
            # the clipboard belongs to the platform, and Windows hands text back with CRLF endings
            check("…and Copy takes the text itself, not a picture of it",
                  (got or "").replace("\r\n", "\n") == "line one\nline two\n", repr(got))
            # a spreadsheet cannot be painted here: the viewer has to say so, not show an empty box
            open_file(page, "plan.xlsx")
            page.wait_for_timeout(500)
            spread = page.evaluate(
                "({img:!!document.querySelector('#fvImg'), pre:!!document.querySelector('#fvPre'),"
                " note:(document.querySelector('#fvStage .setnote')||{}).textContent,"
                " copy:[...document.querySelectorAll('#viewBox .fvfoot button')].some(b=>b.textContent===t('fvCopy'))})"
            )
            check("a file this page cannot paint says so, rather than showing an empty stage",
                  not spread["img"] and not spread["pre"]
                  and spread["note"] == page.evaluate("t('fvNoShow')"), repr(spread["note"]))
            check("…and offers no Copy, because there is nothing there to copy", not spread["copy"])
            # a record whose bytes are gone is the other honest failure
            page.evaluate(
                "attView(tasks.find(x=>x.id==='tSeed1'), {id:'aGone', name:'gone.pdf', type:'application/pdf', size:1024})"
            )
            page.wait_for_timeout(500)
            missing = page.evaluate("(document.querySelector('#fvStage .setnote')||{}).textContent")
            check("…and a file whose bytes are gone says that too",
                  missing == page.evaluate("t('attMissing')"), repr(missing))
        finally:
            ctx.close()

    return [rebuild_keeps_offset, reorder_keeps_offset, hiding_a_card_above_holds_the_card_below,
            shortening_page_clamps_but_never_snaps_to_the_top,
            section_change_starts_at_the_top, phone_keeps_section_and_offset,
            only_two_scrollers_exist, a_card_is_only_as_tall_as_its_content,
            a_loading_card_keeps_its_frame, opening_lands_on_home,
            a_shortcut_link_opens_its_section,
            buttons_do_not_move_the_view, today_button, search_suggestion_marks_the_word,
            a_file_name_is_a_search_result, the_file_viewer_zooms_filters_crops_and_copies,
            the_file_viewer_shows_text_and_says_what_it_cannot_show]


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
