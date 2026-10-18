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
import re
import time
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


def serve(folder=None):
    """A static server on a free loopback port, so a case never depends on a running server.

    `folder` is the project root unless a case is about what is actually *shipped*, which is a
    different document: deploy/index.html carries the policy with the script pinned by hash.
    """
    root = str(folder or ROOT)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, *a):
            pass

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), Quiet)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, "http://127.0.0.1:%d/index.html" % port


def boot(browser, base, width, height, tasks=0, clipboard=False, init=None):
    ctx = browser.new_context(viewport={"width": width, "height": height})
    if clipboard:
        # a clipboard needs permission even in a headless run, and "the copy holds the picture
        # you are looking at" is only worth asserting if the browser will hand it back
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    if init:
        # a case that has to be measured in a browser that behaves differently from this one: the
        # view the app's own window gives the page is one of them
        page.add_init_script(init)
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
    # The offset has to sit past the page's *new* end for this to be a clamp at all, so the reader
    # starts at the end of the page: the card that hides is above them, and the height it took is
    # what can no longer be scrolled to. Anywhere above that end would be the snap to the top this
    # case forbids. Reading cards out of a mid-page offset instead made the case depend on how much
    # a hide happens to shorten the page - when the bands re-flowed so it shortened by less than the
    # offset, there was nothing to clamp and the case failed on its own scenery.
    def shortening_page_clamps_but_never_snaps_to_the_top():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(0); setEditing(true)")
            wait_for(page, "curPage", 0)
            page.evaluate("scrollTo(0, 99999)")
            page.wait_for_timeout(150)
            before = y(page)
            if not check("contract: Home has an end to sit at before a card is hidden", before >= 120,
                         "y=" + str(before)):
                return
            page.evaluate(HIDE_TOP_CARD)
            page.wait_for_timeout(300)
            max_after = page.evaluate("document.documentElement.scrollHeight-innerHeight")
            after = y(page)
            check("when the page gets shorter than the offset, it clamps instead of snapping to the top",
                  after == min(before, max_after) and after > 0,
                  "y %d -> %d (page max %d)" % (before, after, max_after))
        finally:
            ctx.close()

    # ── 3c. what the offset cannot say: the card you were reading keeps its line ────────────
    # A card hidden above the viewport moves everything under it up, so holding the *offset* is not
    # holding the reading - the card under the header has to come back to the same line on screen.
    # Home is seeded with enough due-today rows that the page is still long after the hide: at a
    # short page the answer is the clamp above, and there is no line to hold. A browser that keeps
    # the place itself (scroll anchoring) and the app's own chase have to agree, which is what this
    # measures - they landed 134px apart until the hold stopped reporting a band height as content.
    SEED_TODAY = """(() => {
      const d = new Date(), iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0');
      const list = [...Array(20)].map((_, i) => ({id: 'd' + i, text: 'Due row ' + (i + 1),
        done: false, due: iso, status: 'todo'}));
      localStorage.setItem('pd_tasks', JSON.stringify(list));
    })()"""

    def hiding_a_card_above_holds_the_reading_on_home():
        ctx, page = boot(browser, base, 941, 620, init=SEED_TODAY)
        try:
            page.evaluate("goPage(0); setEditing(true)")
            wait_for(page, "curPage", 0)
            page.evaluate("scrollTo(0, 260)")
            page.wait_for_timeout(150)
            info = page.evaluate(HIDE_TOP_CARD)
            page.wait_for_timeout(600)
            top = page.evaluate(
                "(() => {const n=document.getElementById('w_%s');"
                "return n?Math.round(n.getBoundingClientRect().top):null})()" % (info or {}).get("next", "-")
            )
            check("hiding a card above the fold on Home leaves the reading where it was on screen",
                  bool(info) and top is not None and abs(top - info["top"]) <= 2,
                  "next card top %s -> %s (y now %d)" % (info and info["top"], top, y(page)))
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
    def only_the_document_scrolls_vertically():
        """Nothing but the document may be scrolled vertically, at any width.

        The rule used to be "nothing but the document and the phone pager", and it was satisfied by
        making the pager's content fit - every section stretched to the height of the longest one,
        which is what left a screenful of nothing under a short section and needed a filler div to
        disguise. The pager is now as tall as the section you are on and clips the rest, so the
        question is not whether its content fits (it cannot: Home is shorter than Planner) but
        whether anything can be scrolled. A clipped box cannot be scrolled by a finger or a wheel,
        and - the reason this matters - nor by a scrollIntoView from jumpTo, which an
        `overflow:hidden` box would silently answer by shifting every card sideways up.
        """
        detail = []
        ok = True
        for width, height in ((360, 740), (420, 800), (700, 800), (941, 620)):
            ctx, page = boot(browser, base, width, height)
            try:
                for section in range(6):
                    page.evaluate("goPage(%d)" % section)
                    wait_for(page, "curPage", section)
                    st = page.evaluate(
                        """(() => {
                          const scrollable = [...document.querySelectorAll('body *')].filter(n => {
                            const o = getComputedStyle(n).overflowY;
                            return (o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1;
                          }).map(n => (n.id || n.className || n.tagName).toString().split(' ')[0]);
                          const box = document.getElementById('pages');
                          const pg = box.querySelectorAll(':scope > .page')[curPage];
                          const card = pg.querySelector('[data-widget]');
                          box.scrollTop = 0;
                          if (card) card.scrollIntoView({block: 'center'});
                          const pulled = box.scrollTop;
                          box.scrollTop = 0;
                          return {scrollable: scrollable, pulled: pulled,
                                  overflow: getComputedStyle(box).overflowY};
                        })()"""
                    )
                    if st["scrollable"] or st["pulled"]:
                        ok = False
                        detail.append("%dpx section %d: %s" % (
                            width, section,
                            ("scrolls: " + ", ".join(st["scrollable"])) if st["scrollable"]
                            else "jumpTo shifted the pager by %dpx" % st["pulled"]))
            finally:
                ctx.close()
        check("only the document scrolls vertically - no section, no pager, at any width", ok,
              "; ".join(detail) or "4 widths × 6 sections, and jumpTo moves none of them")

    # ── 6b. on the phone every card is exactly as tall as what it holds ──────────────
    def a_phone_card_is_only_as_tall_as_its_content():
        detail = []
        ok = True
        ctx, page = boot(browser, base, 390, 844)
        try:
            for section in range(6):
                page.evaluate("goPage(%d)" % section)
                wait_for(page, "curPage", section)
                page.wait_for_timeout(120)
                rows = page.evaluate(
                    "(() => {const pg=document.querySelectorAll('#pages > .page')[curPage];"
                    "const cards=[...pg.querySelectorAll(':scope > .page-inner > [data-widget]')];"
                    "return cards.map(c => {const b=c.querySelector('[id^=wb_]'), cs=getComputedStyle(c);"
                    "const inner=b.lastElementChild||b;"
                    "const end=inner.getBoundingClientRect().bottom;"
                    "return {id:c.dataset.widget,"
                    "slack:c.getBoundingClientRect().bottom-parseFloat(cs.paddingBottom)"
                    "-parseFloat(cs.borderBottomWidth)-end};});})()"
                )
                for row in rows:
                    # a line of block spacing (13px) is normal; a stretched card is hundreds
                    if row["slack"] > 24:
                        ok = False
                        detail.append("section %d %s: %.0fpx" % (section, row["id"], row["slack"]))
        finally:
            ctx.close()
        check("the phone stacks cards, so every one is exactly as tall as what it holds",
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

    # ── 8. a reload keeps its place; a new visit opens on Home ──────────────────
    def a_reload_keeps_its_place_but_a_new_visit_opens_on_home():
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.evaluate("scrollTo(0, 500)")
            page.wait_for_timeout(250)
            left_at = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            # written as you scroll, not only when the page unloads: a phone that kills the app
            # outright never fires the unload events, and the place would be lost with them
            kept = page.evaluate("JSON.parse(sessionStorage.getItem('pd_view')||'null')")
            check("the place is written while you scroll, not only as the page unloads",
                  bool(kept) and kept["p"] == left_at["p"] and abs(kept["y"] - left_at["y"]) <= 2,
                  "scrolled to section %s y=%s, the record says %s" % (
                      left_at["p"], left_at["y"], kept))
            page.reload()
            page.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
            settle(page, "Math.round(scrollY)", quiet=150, limit=2000)
            back = page.evaluate("({p:curPage, y:Math.round(scrollY), q:location.search})")
            check("a reload comes back to the section and the offset it was left at",
                  left_at["p"] == 5 and back["p"] == 5
                  and abs(back["y"] - left_at["y"]) <= 4 and back["q"] == "",
                  "left at section %s y=%s · came back to %s y=%s" % (
                      left_at["p"], left_at["y"], back["p"], back["y"]))
            # The record is only worth keeping while it is the page you are refreshing. A place
            # left more than the window ago is a different sitting, and a different sitting opens
            # on Home - that rule is what stops a dashboard coming back on a half-read page days
            # later. The aged record is written here rather than waited out.
            aged = page.evaluate(
                "() => {const v = JSON.parse(localStorage.getItem('pd_view')||'null');"
                "if (v) {v.t = Date.now() - 11*60*1000; localStorage.setItem('pd_view', JSON.stringify(v))}"
                "sessionStorage.removeItem('pd_view'); return v}")
            other = ctx.new_page()
            other.route(lambda url: not url.startswith("blob:"),
                        lambda r: r.continue_() if r.request.url.startswith(base.rsplit("/", 1)[0]) else r.abort())
            other.goto(base)
            other.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
            settle(other, "Math.round(scrollY)", quiet=150, limit=2000)
            fresh = other.evaluate("({p:curPage, y:Math.round(scrollY), q:location.search})")
            other.close()
            check("a place older than the refresh window is not carried into a new visit - Home, at the top",
                  bool(aged) and fresh["p"] == 0 and fresh["y"] == 0 and fresh["q"] == "",
                  "record aged to 11 minutes, new visit at section %s y=%s, url=%r" % (
                      fresh["p"], fresh["y"], fresh["q"]))
            # Locally a reload happens to start at the top on its own; on the CI runner the
            # browser restored 351px of the old offset, which is how this was found. The offset
            # has to belong to the page, not to whether the restore won a race.
            rest = page.evaluate("history.scrollRestoration")
            check("…and the offset belongs to the page, not to the browser's own restore",
                  rest == "manual", "history.scrollRestoration=%r" % rest)
        finally:
            ctx.close()

    # ── 8c. closing the installed app is not a new visit ──────────────────────────────────
    def a_relaunch_of_the_installed_app_reopens_where_it_was_left():
        """Closing the app ends the session, and sessionStorage goes with it, so the local copy is
        the only record left - and the refresh rule throws that away after a minute. Running as
        the installed app, that copy is honoured for a week instead. A plain tab visit with the
        same record still opens on Home: the week belongs to the installed app, not to the site,
        which is what keeps a days-old dashboard from hijacking a new sitting in a browser.
        """
        # the address is part of the record: it is what stops a place taken on one page being
        # restored on another, so the seed has to carry the address it is planted at
        PLANT = ("localStorage.setItem('pd_view', JSON.stringify({p: 3, y: 420, x: 0,"
                 " u: location.pathname + location.search + location.hash,"
                 " t: Date.now() - 3*24*60*60*1000}))")
        STANDALONE = """(() => {
          const mm = window.matchMedia.bind(window);
          window.matchMedia = (q) => q === '(display-mode: standalone)'
            ? {matches: true, media: q, onchange: null, addListener () {}, removeListener () {},
               addEventListener () {}, removeEventListener () {}, dispatchEvent () {return false}}
            : mm(q);
        })()"""
        # the tab first: same record, no installed app
        ctx, page = boot(browser, base, 941, 620, tasks=24, init=PLANT)
        try:
            settle(page, "Math.round(scrollY)", quiet=150, limit=2500)
            gone = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            check("a tab opened on a three-day-old record still opens on Home at the top",
                  gone["p"] == 0 and gone["y"] == 0,
                  "section %s y=%s" % (gone["p"], gone["y"]))
        finally:
            ctx.close()
        # then the installed app: the same record, three days later
        ctx, page = boot(browser, base, 941, 620, tasks=24, init=STANDALONE + ";" + PLANT)
        try:
            settle(page, "Math.round(scrollY)", quiet=150, limit=2500)
            back = page.evaluate("({p:curPage, y:Math.round(scrollY), installed: (() => {try{return "
                                   "matchMedia('(display-mode: standalone)').matches}catch(e){return false}})()})")
            check("closing and reopening the installed app comes back to the section and offset",
                  back["p"] == 3 and abs(back["y"] - 420) <= 6 and back["installed"],
                  "section %s y=%s (installed=%s)" % (back["p"], back["y"], back["installed"]))
        finally:
            ctx.close()

    # ── 8b. a refresh that starts a new session keeps the place too ───────────────
    def a_refresh_that_starts_a_new_session_keeps_its_place():
        """The app's own reload button does not reload this document - it opens the page again in
        a new browsing context. sessionStorage is born empty there (window.name too), so the tab
        record is gone and only the local copy is left to answer. That is the refresh this was
        reported for: a dashboard that came back on Home while the reader had not moved.
        """
        ctx, page = boot(browser, base, 941, 620)
        try:
            # the section with the most room below the fold, so the offset is the thing under
            # test and not a section that happens to fit on one screen
            best = page.evaluate(
                "() => {let at = 0, room = -1;"
                "for (let i = 0; i < pageCount(); i++) {goPage(i);"
                " const r = Math.max(0, document.documentElement.scrollHeight - innerHeight);"
                " if (r > room) {room = r; at = i}}"
                "goPage(at); return {at: at, room: room}}")
            wait_for(page, "curPage", best["at"])
            page.wait_for_timeout(200)
            page.evaluate("scrollTo(0, %d)" % min(380, best["room"]))
            page.wait_for_timeout(300)
            left_at = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            section = best["at"]
            kept = page.evaluate(
                "() => {const v = JSON.parse(localStorage.getItem('pd_view')||'null');"
                "return {v: v, here: location.pathname + location.search + location.hash}}")
            check("the place is kept in the local store too, with the address it belongs to",
                  bool(kept["v"]) and kept["v"]["p"] == section and kept["v"].get("u") == kept["here"]
                  and left_at["y"] >= 100,
                  "left at section %s y=%s (room %s) · the copy says %s for %r" % (
                      left_at["p"], left_at["y"], best["room"], kept["v"], kept["here"]))
            # a second page is a second session: empty sessionStorage, the same local store
            again = ctx.new_page()
            again.route(lambda url: not url.startswith("blob:"),
                        lambda r: r.continue_() if r.request.url.startswith(base.rsplit("/", 1)[0]) else r.abort())
            again.goto(base)
            again.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
            settle(again, "Math.round(scrollY)", quiet=150, limit=2000)
            back = again.evaluate("({p:curPage, y:Math.round(scrollY), s:sessionStorage.getItem('pd_view')})")
            again.close()
            check("a refresh that starts a new session comes back to the same section and offset",
                  left_at["p"] == section and back["p"] == section and abs(back["y"] - left_at["y"]) <= 4,
                  "left at %s y=%s · a new session came back at %s y=%s (its own record: %s)" % (
                      left_at["p"], left_at["y"], back["p"], back["y"], back["s"]))
        finally:
            ctx.close()

    # ── 8c. and the phone comes back to the same place too ────────────────────────
    def a_phone_reload_keeps_its_place():
        ctx, page = boot(browser, base, 390, 844)
        try:
            # instant: goPage's default glides the phone's sections sideways, and the section
            # the page reports follows that glide. Reading it mid-glide (slow CI) records a section
            # the reader was passing through, not the one they were on.
            page.evaluate("goPage(3,{instant:true})")
            wait_for(page, "curPage", 3)
            page.evaluate("scrollTo(0, 420)")
            page.wait_for_timeout(250)
            left_at = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            page.reload()
            page.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
            settle(page, "Math.round(scrollY)", quiet=150, limit=2000)
            back = page.evaluate("({p:curPage, y:Math.round(scrollY)})")
            check("on the phone a reload comes back to the same section and the same offset",
                  left_at["p"] == 3 and back["p"] == 3 and abs(back["y"] - left_at["y"]) <= 6,
                  "left at section %s y=%s · came back to %s y=%s" % (
                      left_at["p"], left_at["y"], back["p"], back["y"]))
        finally:
            ctx.close()

    # ── 8d. every section, at every width, comes back to exactly where it was ───────────────
    def every_section_keeps_its_place_after_a_reload():
        """Six sections × three widths, measured on the real layout.

        The cases above prove the mechanism at three places; this proves the grid. Any layout
        change that moves content inside a section - a taller card, an extra row, a different
        column split - shows up here as a reload that lands somewhere else. The offset alone
        would miss it: a y that comes back to the same number while the card under it has moved
        is still the wrong place, so the card at the top edge is recorded too and has to return
        at the same distance from the top of the screen.
        """
        # the section you are on, whichever layout: only the desktop puts .active on a page, and
        # on the phone the current one is the one curPage names
        instr = ("const pg = document.querySelector('.page[data-page=\"' + curPage + '\"]')"
                 " || document.querySelector('.page.active');")
        BEFORE = """() => {
          %s
          const cards = [...(pg ? pg.querySelectorAll('[data-widget]') : [])]
            .map(n => ({id: n.dataset.widget, abs: Math.round(n.getBoundingClientRect().top + scrollY)}))
            .sort((a, b) => a.abs - b.abs);
          const above = cards.filter(c => c.abs <= Math.round(scrollY) + 4);
          const at = above.length ? above[above.length - 1] : (cards[0] || {id: '', abs: 0});
          return {y: Math.round(scrollY), wid: at.id, top: at.abs,
                  maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight)};
        }""" % instr
        AFTER = ("(wid) => {%s"
                 "const n = (wid && pg) ? pg.querySelector('[data-widget=\"' + wid + '\"]') : null;"
                 "return {p: curPage, y: Math.round(scrollY),"
                 " top: n ? Math.round(n.getBoundingClientRect().top + scrollY) : null}}") % instr

        for width in (390, 1280, 1600):
            ctx, page = boot(browser, base, width, 844 if width == 390 else 620)
            bad = []
            try:
                for section in range(6):
                    page.evaluate("goPage(%d)" % section)
                    wait_for(page, "curPage", section)
                    page.wait_for_timeout(120)
                    # as far down the section as it will actually go: a short section has no
                    # offset to lose, a long one needs a real one
                    target = min(420, page.evaluate(BEFORE)["maxY"])
                    page.evaluate("scrollTo(0, %d)" % target)
                    page.wait_for_timeout(220)
                    before = page.evaluate(BEFORE)
                    page.reload()
                    page.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
                    settle(page, "Math.round(scrollY)", quiet=200, limit=2400)
                    after = page.evaluate(AFTER, before["wid"])
                    drift = None if after["top"] is None else abs(after["top"] - before["top"])
                    if (after["p"] != section or abs(after["y"] - before["y"]) > 4
                            or drift is None or drift > 2):
                        bad.append("s%d: left at %d · came back at %d, section %s%s" % (
                            section, before["y"], after["y"], after["p"],
                            "" if drift is None else " · the card under it moved %dpx" % drift))
            finally:
                ctx.close()
            check("a reload returns to the same place in all six sections at %dpx" % width,
                  not bad, "; ".join(bad) or "6 sections · same offset, same card under it")

    # ── 8f. and the position is taken off a clock, for a view that sends nothing ──────────────
    def the_place_is_taken_on_a_clock_when_no_scroll_event_comes():
        """The app's own window can hold a page that never paints, and a view that never paints
        delivers no scroll event, no frame and no leaving event - the position would never be
        reported at all. This case loads the page into a browser that swallows every scroll
        listener, which is that silence, and requires the record to be taken anyway.
        """
        NO_SCROLL_EVENTS = """(() => {const orig = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, fn, opts) {
            if (type === 'scroll') return;   /* this view delivers none */
            return orig.call(this, type, fn, opts);
          };})()"""
        ctx, page = boot(browser, base, 941, 620, init=NO_SCROLL_EVENTS)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.wait_for_timeout(150)
            page.evaluate("scrollTo(0, 430)")
            page.wait_for_timeout(1600)
            kept = page.evaluate("JSON.parse(localStorage.getItem('pd_view')||'null')")
            check("with no scroll event at all the place is still taken, off the clock",
                  bool(kept) and kept.get("p") == 5 and abs(kept.get("y", 0) - 430) <= 2,
                  "scrolled to 430 with every scroll listener swallowed · the record says %s" % (kept,))
        finally:
            ctx.close()

    # ── 8e. the record is written even when the view is not painting ──────────────────────────
    def the_place_is_written_without_a_frame():
        """A view that never paints never delivers a frame, and a save that waits for one is
        dropped - with its guard left set, every later scroll is dropped with it, and the reload
        puts back a position the reader had already left. Here the page is asked to save with
        requestAnimationFrame stubbed out, which is the page a webview that is not compositing
        shows.
        """
        ctx, page = boot(browser, base, 941, 620)
        try:
            page.evaluate("goPage(5)")
            wait_for(page, "curPage", 5)
            page.evaluate("window.requestAnimationFrame = () => 0")
            page.evaluate("scrollTo(0, 460)")
            page.wait_for_timeout(400)
            kept = page.evaluate("JSON.parse(sessionStorage.getItem('pd_view')||'null')")
            check("the place is written with no frame in sight, so a view that is not painting cannot lose it",
                  bool(kept) and kept.get("p") == 5 and abs(kept.get("y", 0) - 460) <= 2,
                  "scrolled to 460 with rAF stubbed out · the record says %s" % (kept,))
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

    # ── 9. the phone puts up no empty space, and grows with what you add ───────────────────────
    def a_phone_section_is_as_tall_as_its_content():
        ctx, page = boot(browser, base, 390, 844, tasks=6)
        try:
            worst = []
            for section in range(6):
                page.evaluate("goPage(%d)" % section)
                wait_for(page, "curPage", section)
                st = page.evaluate(
                    """(() => {
                      const box = document.getElementById('pages');
                      const pg = box.querySelectorAll(':scope > .page')[curPage];
                      const cards = [...pg.querySelectorAll(':scope > .page-inner > [data-widget]')];
                      const last = cards[cards.length - 1];
                      const b = box.getBoundingClientRect();
                      const floor = Math.max(window.innerHeight, b.bottom + scrollY);
                      return {box: Math.round(b.height),
                              content: Math.round(pg.scrollHeight),
                              tail: last ? Math.round(b.bottom - last.getBoundingClientRect().bottom) : null,
                              below: Math.round(document.documentElement.scrollHeight - floor),
                              filler: pg.querySelectorAll('.swipe-spacer').length};
                    })()"""
                )
                worst.append((section, st))
            slack = [(s, st["tail"]) for s, st in worst if st["tail"] is None or st["tail"] > 40]
            check("a section ends with its last card, not with a screenful of nothing",
                  not slack and all(st["filler"] == 0 for _, st in worst),
                  "; ".join("p%d leaves %spx" % (s, t) for s, t in slack)
                  or "; ".join("p%d box %d ≈ content %d" % (s, st["box"], st["content"]) for s, st in worst[:3]))
            # below the box there is either nothing, or the rest of a viewport a short section does
            # not fill: what must not come back is the document being longer than both
            check("…and nothing is drawn below the section, past the end of the screen it sits in",
                  all(st["below"] <= 2 for _, st in worst),
                  "; ".join("p%d %+dpx" % (s, st["below"]) for s, st in worst))
        finally:
            ctx.close()

    # ── 10. add a card and the phone page gets taller ──────────────────────────────────────────
    def a_phone_page_grows_with_what_you_add():
        ctx, page = boot(browser, base, 390, 844, tasks=6)
        try:
            page.evaluate("goPage(3)")
            wait_for(page, "curPage", 3)
            before = page.evaluate(
                "({doc: document.documentElement.scrollHeight,"
                " box: Math.round(document.getElementById('pages').getBoundingClientRect().height),"
                " board: Math.round(document.querySelector('#w_kanban .kb').getBoundingClientRect().height)})"
            )
            # the board's own button, the dialog, the save: the chain a person actually uses
            page.evaluate("[...document.querySelectorAll('#w_kanban button')]"
                          ".find(b=>/add card/i.test(b.textContent)).click()")
            page.wait_for_selector("#kText", timeout=3000)
            page.fill("#kText", "A card that makes the page longer")
            page.click("#kSave")
            page.wait_for_timeout(600)
            after = page.evaluate(
                "({doc: document.documentElement.scrollHeight,"
                " box: Math.round(document.getElementById('pages').getBoundingClientRect().height),"
                " board: Math.round(document.querySelector('#w_kanban .kb').getBoundingClientRect().height),"
                " cards: document.querySelectorAll('#w_kanban .kbcard').length,"
                " tail: (() => {const b=document.getElementById('pages').getBoundingClientRect();"
                "   const pg=document.querySelectorAll('#pages > .page')[curPage];"
                "   const cs=[...pg.querySelectorAll(':scope > .page-inner > [data-widget]')];"
                "   return cs.length?Math.round(b.bottom-cs[cs.length-1].getBoundingClientRect().bottom):null})()})"
            )
            check("adding a card grows the phone page by the card, not by nothing",
                  after["board"] > before["board"] + 20 and after["doc"] > before["doc"] + 20
                  and abs(after["doc"] - before["doc"] - (after["box"] - before["box"])) <= 2,
                  "board %d->%d · document %d->%d · box %d->%d"
                  % (before["board"], after["board"], before["doc"], after["doc"], before["box"], after["box"]))
            check("…and the section still ends with its last card",
                  after["tail"] is not None and after["tail"] <= 40,
                  "tail=%spx after %d cards" % (after["tail"], after["cards"]))
        finally:
            ctx.close()

    # ── 10c. the page that ships runs with its script pinned by hash ─────────────────────
    def the_shipped_page_runs_under_its_pinned_script_hash():
        """The bundle is not the source: _deploy.mjs replaces 'unsafe-inline' with the SHA-256 of
        the page's one script, so the shipped document has no blanket allowance for inline code.
        That is only worth having if the page still works, so this drives the *deployed* copy:
        it boots, its own policy names the hash, and a script injected after the fact is refused.
        """
        httpd, shipped = serve(ROOT / "deploy")
        try:
            ctx, page = boot(browser, shipped, 941, 620)
            try:
                # a listener has to be in place before the document parses to see boot-time
                # violations, so it goes in and the page is loaded once more with it
                page.add_init_script(
                    "window.__sv = [];"
                    "addEventListener('securitypolicyviolation', e => "
                    "window.__sv.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));")
                page.reload()
                page.wait_for_function(
                    "window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
                page.wait_for_timeout(400)
                state = page.evaluate(
                    "() => ({policy: (document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')"
                    " || {}).content || '', booted: typeof buildPages === 'function',"
                    " cards: document.querySelectorAll('[data-widget]').length,"
                    " sv: window.__sv || []})")
                clause = (re.search(r"script-src[^;]*;", state["policy"]).group(0)
                          if re.search(r"script-src[^;]*;", state["policy"]) else "")
                check("the shipped page pins its script by hash, with no 'unsafe-inline' for scripts",
                      "'sha256-" in clause and "unsafe-inline" not in clause
                      and clause.startswith("script-src 'self'"),
                      clause or "no script-src clause")
                check("…and it is the page that runs, with nothing refused from its own code",
                      state["booted"] and state["cards"] > 20 and state["sv"] == [],
                      "%d cards · violations: %s" % (state["cards"], state["sv"] or "none"))
                pwned = page.evaluate(
                    "() => {const s = document.createElement('script');"
                    "s.textContent = 'window.__pwned = 1;'; document.head.appendChild(s);"
                    "return new Promise(r => setTimeout(() => r(window.__pwned || 0), 350))}")
                after = page.evaluate("window.__sv || []")
                check("…and a script injected into the shipped page is refused",
                      pwned == 0 and any("script-src" in v for v in after),
                      "injected script ran: %s · violation: %s" % (
                          bool(pwned), [v for v in after if "script-src" in v][:1] or "none"))
            finally:
                ctx.close()
        finally:
            httpd.shutdown()

    # ── 10d. a passphrase seals the files and the provider key at rest ───────────────────
    def a_passphrase_seals_the_files_and_the_provider_key():
        """Two things sit in the browser in the clear: the bytes of an attachment (IndexedDB) and
        the metals provider key (localStorage). A passphrase is supposed to seal both with a key
        derived from it and not stored anywhere - so this measures the store, not the intention:
        the record holds a sealed field and no Blob, the marker text is not in it, the key is
        gone from localStorage, and the session is still usable after enabling.
        Then it is relaunched: nothing is readable until the passphrase opens it, the wrong one
        does not, and removing the protection puts both back the way they were.
        """
        PASS = "correct horse battery"
        MARK = "PLAINTEXT-MARKER-9f2c7a"
        ctx, page = boot(browser, base, 941, 620)
        try:
            made = page.evaluate(
                "async (mark) => {"
                "  await filePut({id: 'lk1', name: 'note.txt', type: 'text/plain', size: mark.length,"
                "    blob: new Blob([mark], {type: 'text/plain'})});"
                "  await setByokKey('sk-test-BYOK-123');"
                "  const before = await fileGet('lk1');"
                "  return {before: before && !before.enc && !!before.blob,"
                "          key: byokKey(), stored: localStorage.getItem('pd_metals_key')}}", (MARK,))
            check("contract: a file and a provider key are stored usefully before any lock exists",
                  made["before"] and made["key"] == "sk-test-BYOK-123" and made["stored"] == "sk-test-BYOK-123",
                  "file readable: %s · key in localStorage: %s" % (made["before"], bool(made["stored"])))
            armed = page.evaluate(
                "async (args) => {const [pass, mark] = args;"
                "  const r = await lockEnable(pass);"
                "  const rec = await fileRaw('lk1');"
                "  const lock = JSON.parse(localStorage.getItem('pd_lock') || 'null');"
                "  const read = await fileGet('lk1');"
                "  return {ok: r.ok, why: r.why || '', sealed: !!(rec && rec.enc), blob: !!(rec && rec.blob),"
                "    plainInRecord: JSON.stringify(rec || {}).indexOf(mark) >= 0,"
                "    passInLock: JSON.stringify(lock || {}).indexOf(pass) >= 0,"
                "    haveSalt: !!(lock && lock.salt && lock.check), iter: (lock || {}).iter || 0,"
                "    keyGone: localStorage.getItem('pd_metals_key') === null,"
                "    keySealed: !!localStorage.getItem('pd_metals_key_enc'),"
                "    key: byokKey(), read: read && read.blob ? 'bytes' : (read && read.locked ? 'locked' : 'none')}}",
                (PASS, MARK))
            check("setting a passphrase seals the stored file and the provider key",
                  armed["ok"] and armed["sealed"] and not armed["blob"] and not armed["plainInRecord"]
                  and armed["keyGone"] and armed["keySealed"] and armed["read"] == "bytes",
                  "sealed record: %s (Blob %s) · marker in it: %s · key moved: %s"
                  % (armed["sealed"], armed["blob"], armed["plainInRecord"], armed["keySealed"]))
            check("…and the passphrase itself is nowhere in the browser, only a salt and a check value",
                  armed["haveSalt"] and not armed["passInLock"] and armed["iter"] >= 200000,
                  "salt+check present: %s · passphrase found: %s · %s iterations"
                  % (armed["haveSalt"], armed["passInLock"], armed["iter"]))
            check("…and this session can still use both, without being asked again",
                  armed["key"] == "sk-test-BYOK-123", "provider key readable while unlocked: %s" % bool(armed["key"]))
            ui = page.evaluate(
                "() => {const s = document.querySelector('[data-set=\"lock\"]');"
                "  return {there: !!s, badge: s ? (s.querySelector('.setb') || {}).textContent : ''}}")
            check("the Settings card offers the lock, and says which state it is in",
                  ui["there"] and bool(ui["badge"]), "lock card: %s · badge: %r" % (ui["there"], ui["badge"]))

            # a relaunch: a new page, no key in memory, the same store
            page.reload()
            page.wait_for_function("window.buildPages && document.querySelectorAll('[data-widget]').length > 20")
            shut = page.evaluate(
                "async () => {const rec = await fileGet('lk1');"
                "  return {on: lockOn(), open: lockOpen(), key: byokKey(),"
                "    read: rec && rec.locked ? 'locked' : (rec && rec.blob ? 'bytes' : 'none'),"
                "    bytes: rec && rec.blob ? 1 : 0}}")
            check("after a relaunch nothing sealed is readable until the passphrase is given",
                  shut["on"] and not shut["open"] and shut["key"] == "" and shut["read"] == "locked",
                  "lock on: %s · unlocked: %s · key: %r · file: %s"
                  % (shut["on"], shut["open"], shut["key"], shut["read"]))
            wrong = page.evaluate(
                "async () => {const r = await lockUnlock('not the passphrase');"
                "  return {ok: r.ok, why: r.why || '', open: lockOpen(), key: byokKey()}}")
            check("…and the wrong passphrase does not open it",
                  not wrong["ok"] and wrong["why"] == "lockWrong" and not wrong["open"] and wrong["key"] == "",
                  "refused: %s · still locked: %s" % (not wrong["ok"], not wrong["open"]))
            opened = page.evaluate(
                "async (args) => {const [pass, mark] = args;"
                "  const r = await lockUnlock(pass);"
                "  const rec = await fileGet('lk1');"
                "  const text = rec && rec.blob ? await rec.blob.text() : '';"
                "  return {ok: r.ok, text: text, same: text === mark, key: byokKey()}}", (PASS, MARK))
            check("…the right one opens it, and the file comes back byte for byte",
                  opened["ok"] and opened["same"] and opened["key"] == "sk-test-BYOK-123",
                  "opened: %s · bytes equal: %s · key back: %s"
                  % (opened["ok"], opened["same"], bool(opened["key"])))
            off = page.evaluate(
                "async (pass) => {const r = await lockDisable(pass);"
                "  const rec = await fileRaw('lk1');"
                "  return {ok: r.ok, on: lockOn(), blob: !!(rec && rec.blob), sealed: !!(rec && rec.enc),"
                "    key: localStorage.getItem('pd_metals_key'), sealedKey: localStorage.getItem('pd_metals_key_enc')}}"
                , PASS)
            check("removing the protection puts the file and the key back in the clear",
                  off["ok"] and not off["on"] and off["blob"] and not off["sealed"]
                  and off["key"] == "sk-test-BYOK-123" and off["sealedKey"] is None,
                  "lock off: %s · Blob back: %s · key back: %s" % (not off["on"], off["blob"], off["key"]))
        finally:
            ctx.close()

    # ── 11. the desktop grid is bands, not columns: one row, one top, one bottom ────────
    def the_desktop_rows_are_aligned_bands():
        detail = []
        ok = True
        for width in (941, 1280, 1600):
            ctx, page = boot(browser, base, width, 900, tasks=6)
            try:
                for section in range(6):
                    page.evaluate("goPage(%d)" % section)
                    wait_for(page, "curPage", section)
                    page.wait_for_timeout(120)
                    st = page.evaluate(
                        """(() => {
                          const inner = document.querySelector('.page.active .page-inner');
                          const gap = parseFloat(getComputedStyle(inner).rowGap) || 0;
                          const cards = [...inner.querySelectorAll(':scope > [data-widget]')].map(c => {
                            const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
                            const b = c.querySelector('[id^=wb_]');
                            const end = (b.lastElementChild || b).getBoundingClientRect().bottom;
                            return {id: c.dataset.widget, top: Math.round(r.top), bottom: Math.round(r.bottom),
                                    left: Math.round(r.left), right: Math.round(r.right),
                                    wide: cs.gridColumnEnd === '-1',
                                    slack: Math.round(r.bottom - parseFloat(cs.paddingBottom)
                                                      - parseFloat(cs.borderBottomWidth) - end)};
                          });
                          /* a band is the row: the cards that share a top edge */
                          const bands = [];
                          cards.forEach(c => {
                            const b = bands.find(x => Math.abs(x.top - c.top) <= 1);
                            if (b) b.cards.push(c); else bands.push({top: c.top, cards: [c]});
                          });
                          bands.sort((a, b) => a.top - b.top);
                          let ragged = 0, worstRagged = 0, overlap = 0, tight = 0, gapBad = 0, worstGap = 0;
                          bands.forEach(bd => {
                            const bottom = Math.max.apply(null, bd.cards.map(c => c.bottom));
                            bd.cards.forEach(c => {
                              const d = bottom - c.bottom;
                              if (d > 1) {ragged++; if (d > worstRagged) worstRagged = d}
                            });
                            /* the band is as tall as its tallest card's own content: at least one
                               card in it is not stretched, or the height came from nowhere */
                            if (Math.min.apply(null, bd.cards.map(c => c.slack)) <= 24) tight++;
                          });
                          for (let i = 1; i < bands.length; i++) {
                            const g = bands[i].top - Math.max.apply(null, bands[i - 1].cards.map(c => c.bottom));
                            if (g < 0) overlap++;
                            if (Math.abs(g - gap) > 1) {gapBad++; worstGap = Math.max(worstGap, g)}
                          }
                          return {cards: cards.length, bands: bands.length, ragged: ragged,
                                  worstRagged: Math.round(worstRagged), overlap: overlap,
                                  tight: tight, gapBad: gapBad, worstGap: Math.round(worstGap), gap: gap};
                        })()"""
                    )
                    if (st["ragged"] or st["overlap"] or st["tight"] != st["bands"]
                            or st["gapBad"] or st["bands"] < 1):
                        ok = False
                        detail.append("%dpx p%d: %d ragged (%dpx) · %d overlap · %d/%d bands content-sized · %d band gaps off (%dpx)"
                                      % (width, section, st["ragged"], st["worstRagged"], st["overlap"],
                                         st["tight"], st["bands"], st["gapBad"], st["worstGap"]))
            finally:
                ctx.close()
        check("the desktop rows line up - each band one top and one bottom, spaced by the grid gap",
              ok, "; ".join(detail) or "3 widths × 6 sections · every row a band, every band content-sized")

    # ── 10. a stretched card spends its slack on the reading ────────────────────────────────
    def a_stretched_card_spends_its_slack_on_the_reading():
        """A band gives every card in it the tallest card's height, and that slack used to sit
        inside the shorter card as blank space. Three cards spend it instead: the review chart
        takes it as track, a task list spreads its rows through it, and a short read sits in the
        middle of it.

        Each is measured by handing the card a height it did not ask for - what a tall neighbour
        does - and then taking it back, because a card that grew from the height it was given
        would feed its own band taller on every pass. The chart is seeded with a few closed
        cards so it has a shape to draw rather than a flat row of stubs.
        """
        now = int(time.time() * 1000)
        seeded = [{"id": "s%d" % i, "text": "closed %d" % i, "done": True, "due": "", "status": "done",
                   "doneAt": now - (i * 2 + 1) * 3600 * 1000} for i in range(3)]
        seeded += [{"id": "o%d" % i, "text": "open %d" % i, "done": False, "due": "", "status": "todo"}
                   for i in range(4)]
        seed = "localStorage.setItem('pd_tasks', %s)" % json.dumps(json.dumps(seeded))

        # what the reading occupies inside its card, in every case
        # the track is the plot inside a column, not the whole box: the weekday letters sit under
        # it for the seven-day window and are not part of what a bar is scaled against
        CHART = """() => {
          const card = document.querySelector('#w_week');
          const cols = [...document.querySelectorAll('#wb_week .wkcol')];
          const plots = cols.map(c => c.querySelector('.wkplot')).filter(Boolean);
          const bars = cols.map(c => c.querySelector('.wkbar')).filter(Boolean);
          const rb = plots[0].getBoundingClientRect();
          const tops = bars.map(b => b.getBoundingClientRect().top);
          const feet = bars.map((b, i) => Math.round(b.getBoundingClientRect().bottom
                                                     - plots[i].getBoundingClientRect().bottom));
          return {track: Math.round(rb.height), bars: bars.length,
                  share: +(((rb.bottom - Math.min.apply(null, tops)) / rb.height)).toFixed(3),
                  offFoot: Math.max.apply(null, feet.map(Math.abs)),
                  card: Math.round(card.getBoundingClientRect().height)};
        }"""
        ROWS = """() => {
          const list = document.querySelector('#w_tasks #wb_tasks .list'), card = document.querySelector('#w_tasks');
          const rl = list.getBoundingClientRect(), li = [...list.children].map(n => n.getBoundingClientRect());
          const gaps = li.slice(1).map((r, i) => Math.round(r.top - li[i].bottom));
          return {rows: li.length, head: Math.round(li[0].top - rl.top),
                  foot: Math.round(rl.bottom - li[li.length - 1].bottom),
                  widest: gaps.length ? Math.max.apply(null, gaps) : 0,
                  card: Math.round(card.getBoundingClientRect().height)};
        }"""
        MID = """() => {
          const body = document.querySelector('#wb_quote'), card = document.querySelector('#w_quote');
          const inner = body.firstElementChild || body;
          const rb = body.getBoundingClientRect(), ri = inner.getBoundingClientRect();
          return {slack: Math.round(rb.height - ri.height), top: Math.round(ri.top - rb.top),
                  bottom: Math.round(rb.bottom - ri.bottom), card: Math.round(card.getBoundingClientRect().height)};
        }"""

        def hand(card_id, height):
            """Give a card a height it did not ask for, the way a tall neighbour does."""
            page.add_style_tag(content="#%s{min-height:%dpx}" % (card_id, height))
            page.wait_for_timeout(220)

        def take_back(card_id):
            page.evaluate("(id) => document.querySelectorAll('style').forEach(s => "
                          "{if (s.textContent.indexOf('#' + id + '{min-height') >= 0) s.remove()})", card_id)
            page.wait_for_timeout(220)

        ctx, page = boot(browser, base, 1280, 700, init=seed)
        try:
            page.evaluate("goPage(0)")
            page.wait_for_timeout(300)
            rest = page.evaluate(CHART)
            check("the review chart is a share of its track at rest - the busiest day fills it",
                  rest["share"] >= 0.95 and rest["offFoot"] <= 1 and 26 <= rest["track"] <= 46
                  and rest["bars"] >= 7,
                  "%(bars)s bars on a %(track)spx track · tall %(share)s of it · feet off by %(offFoot)spx" % rest)
            hand("w_week", 620)
            grown = page.evaluate(CHART)
            check("…and given a band's height the chart is what grows, not the blank space under it",
                  grown["card"] >= 600 and grown["track"] >= 300 and grown["share"] >= 0.95
                  and grown["offFoot"] <= 1 and grown["track"] > rest["track"] * 5,
                  "card %(card)spx · track %(track)spx (was %(was)spx) · tall %(share)s · feet off by %(offFoot)spx"
                  % dict(grown, was=rest["track"]))
            take_back("w_week")
            back = page.evaluate(CHART)
            check("…and the card returns to the height its own content wants, so a band cannot ratchet",
                  abs(back["track"] - rest["track"]) <= 1 and abs(back["card"] - rest["card"]) <= 1,
                  "back to a %dpx track and a %dpx card (was %dpx / %dpx)"
                  % (back["track"], back["card"], rest["track"], rest["card"]))
            page.evaluate("goPage(3)")
            page.wait_for_timeout(300)
            flat = page.evaluate(ROWS)
            check("a task list with no slack to spend stacks its rows, as it always did",
                  flat["widest"] == 0 and flat["head"] == 0 and flat["foot"] == 0 and flat["rows"] >= 3,
                  "%(rows)s rows in %(card)spx, widest gap %(widest)spx" % flat)
            hand("w_tasks", 620)
            spread = page.evaluate(ROWS)
            check("…and given a band's height the rows spread through it, first at the top and last at the foot",
                  spread["card"] >= 600 and spread["widest"] >= 20 and spread["head"] <= 1 and spread["foot"] <= 1,
                  "card %(card)spx · %(rows)s rows · widest gap %(widest)spx · head %(head)spx · foot %(foot)spx" % spread)
            take_back("w_tasks")
            packed = page.evaluate(ROWS)
            check("…and those rows close up again when the height is taken back",
                  packed["widest"] == 0 and abs(packed["card"] - flat["card"]) <= 1,
                  "widest gap back to %(widest)spx, card %(card)spx" % packed)
            # the quote lives on Home, and a section that is not showing has no box to measure
            page.evaluate("goPage(0)")
            page.wait_for_timeout(250)
            hand("w_quote", 400)
            middle = page.evaluate(MID)
            check("a short read sits in the middle of the height it is given",
                  middle["card"] >= 390 and middle["slack"] >= 100
                  and abs(middle["top"] - middle["bottom"]) <= 2,
                  "card %(card)spx · %(slack)spx of slack · %(top)spx above and %(bottom)spx below" % middle)
            take_back("w_quote")
        finally:
            ctx.close()

        # the phone gives every card a row of its own, so there is nothing to spend and none of
        # this may show there
        ctx, page = boot(browser, base, 390, 844, init=seed)
        try:
            page.evaluate("goPage(0)")
            page.wait_for_timeout(300)
            rest = page.evaluate(CHART)
            mid = page.evaluate(MID)
            check("on the phone the same three cards are only as tall as what they hold",
                  rest["track"] <= 46 and mid["slack"] <= 6,
                  "chart track %(track)spx at a card of %(card)spx · the quote has %(slack)spx of slack"
                  % dict(rest, slack=mid["slack"]))
        finally:
            ctx.close()

    # ── 10b. the height a rebuild holds a card at is its content's, not its band's ──────────
    # While a rebuild draws, each card is held at the height it had, so the page cannot collapse
    # for a frame. The number it holds has to be the height the *content* wants. A card that
    # spends its band's height reports the stretched height instead when it is measured inside
    # the flex line, and that figure becomes a floor the card can never come back under: a band
    # that went tall because a neighbour's list grew stays tall after the rows are gone, and the
    # chart inside it keeps a track it no longer has content for. Nothing here is handed a
    # height - the rows are added and removed the way the app adds and finishes them.
    def a_rebuilt_card_holds_its_content_height_not_its_band():
        READ = """() => {
          const wk = document.querySelector('#w_week'), tk = document.querySelector('#w_todayTasks');
          const plot = document.querySelector('#wb_week .wkcol .wkplot');
          const held = ['#wb_week', '#wb_todayTasks'].map(s => {
            const n = document.querySelector(s); return n ? n.getAttribute('style') || '' : '';
          }).filter(Boolean);
          return {weekCard: Math.round(wk.getBoundingClientRect().height),
                  track: plot ? Math.round(plot.getBoundingClientRect().height) : null,
                  rows: tk.querySelectorAll('.list > *').length,
                  tasksCard: Math.round(tk.getBoundingClientRect().height),
                  held: held};
        }"""
        # due today, because that is the only list this card shows: the reader's own date, not
        # this machine's, since the app decides "today" in the browser
        GROW = """() => {
          const d = new Date(), iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
            + '-' + String(d.getDate()).padStart(2, '0');
          for (let i = 0; i < 10; i++) tasks.push({id: 'gSeed' + i, text: 'row ' + (i + 1),
            done: false, due: iso, status: 'todo'});
          store.set('pd_tasks', tasks); buildPages(); return tasks.length;
        }"""
        SHRINK = """() => {
          for (let i = tasks.length - 1; i >= 0; i--) if (/^gSeed/.test(tasks[i].id)) tasks.splice(i, 1);
          store.set('pd_tasks', tasks); buildPages(); return tasks.length;
        }"""
        ctx, page = boot(browser, base, 941, 760)
        try:
            page.evaluate("goPage(0)")
            page.wait_for_timeout(300)
            rest = page.evaluate(READ)
            page.evaluate(GROW)
            # long enough for the hold to settle and the band to take the taller list
            page.wait_for_timeout(900)
            tall = page.evaluate(READ)
            check("a long task list makes its band taller, and the chart in it grows to match",
                  tall["rows"] >= 5 and tall["rows"] > rest["rows"]
                  and tall["weekCard"] >= rest["weekCard"] + 40
                  and tall["track"] >= rest["track"] + 40,
                  "rows %(rows_w)s · week card %(weekCard_w)spx (was %(weekCard_r)spx) · track %(track_w)spx (was %(track_r)spx)"
                  % dict(track_r=rest["track"], weekCard_r=rest["weekCard"], track_w=tall["track"],
                         weekCard_w=tall["weekCard"], rows_w=tall["rows"]))
            page.evaluate(SHRINK)
            # the hold is deliberately kept for 1.5s before a card is allowed to shrink
            page.wait_for_timeout(2500)
            back = page.evaluate(READ)
            check("…and with the rows gone again the band comes back down, so nothing ratchets",
                  back["rows"] <= 1 and abs(back["weekCard"] - rest["weekCard"]) <= 2
                  and abs(back["track"] - rest["track"]) <= 2
                  and abs(back["tasksCard"] - rest["tasksCard"]) <= 2 and back["held"] == [],
                  "week card back to %(weekCard)spx, track to %(track)spx, rows %(rows)s"
                  % back + (" · still held: " + ", ".join(back["held"]) if back["held"] else ""))
        finally:
            ctx.close()

    return [rebuild_keeps_offset, reorder_keeps_offset, hiding_a_card_above_holds_the_card_below,
            shortening_page_clamps_but_never_snaps_to_the_top, hiding_a_card_above_holds_the_reading_on_home,
            section_change_starts_at_the_top, phone_keeps_section_and_offset,
            only_the_document_scrolls_vertically, a_phone_card_is_only_as_tall_as_its_content,
            a_loading_card_keeps_its_frame,            a_reload_keeps_its_place_but_a_new_visit_opens_on_home,
            a_relaunch_of_the_installed_app_reopens_where_it_was_left,
            a_refresh_that_starts_a_new_session_keeps_its_place,
            a_phone_reload_keeps_its_place,
            every_section_keeps_its_place_after_a_reload,
            the_place_is_written_without_a_frame,
            the_place_is_taken_on_a_clock_when_no_scroll_event_comes,
            a_shortcut_link_opens_its_section,
            buttons_do_not_move_the_view, today_button, search_suggestion_marks_the_word,
            a_file_name_is_a_search_result, the_file_viewer_zooms_filters_crops_and_copies,
            the_file_viewer_shows_text_and_says_what_it_cannot_show,
            a_phone_section_is_as_tall_as_its_content, a_phone_page_grows_with_what_you_add,
            the_desktop_rows_are_aligned_bands,
            the_shipped_page_runs_under_its_pinned_script_hash,
            a_passphrase_seals_the_files_and_the_provider_key,
            a_stretched_card_spends_its_slack_on_the_reading,
            a_rebuilt_card_holds_its_content_height_not_its_band]


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
