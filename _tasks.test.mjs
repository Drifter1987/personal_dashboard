/* Drives the page's real repeat / successor / rollover code, not a copy of it.
 *
 * These three rules are the ones a careless edit breaks silently: a completion that forgets to
 * spawn, a spawn that spawns twice, a date that lands in the past, and a rollover that runs more
 * than once a day or rewrites a finished card. All four look fine in a screenshot, so they are
 * executed here against a fixed clock instead of pattern-matched.
 *
 * The code is lifted out of index.html at run time and placed in a scope where `tasks`, `store`
 * and `Date` are the harness's own - the real `new Date(y, m, d)` arithmetic still runs, only
 * "now" is pinned. No dependencies.
 */
import fs from "node:fs";

const page = fs.readFileSync("index.html", "utf8");

/* ── lifting the real code out of the page ─────────────────────────────────────
   Two markers delimit one contiguous block (the date helpers through armRollover); kbSet is a
   separate line further down and is taken whole, because it is the board's own completion path
   and must be held to the same rule as the circle's. */
function between(from, to) {
  const a = page.indexOf(from);
  if (a < 0) throw new Error("index.html no longer contains " + JSON.stringify(from));
  const b = page.indexOf(to, a + from.length);
  if (b < 0) throw new Error("index.html no longer contains " + JSON.stringify(to));
  return page.slice(a, b);
}
function wholeLine(head) {
  const i = page.indexOf("\n" + head);
  if (i < 0) throw new Error("index.html no longer contains " + JSON.stringify(head));
  return page.slice(i + 1, page.indexOf("\n", i + 1));
}

const CORE = between("const isoDay=", "const PRIO_KEY=");
const KB = wholeLine("function kbSet(");
for (const fn of ["nextDue", "spawnNext", "setDone", "rollOverdue", "armRollover"]) {
  if (!new RegExp("function " + fn + "\\b").test(CORE))
    throw new Error("the lifted repeat block no longer contains " + fn);
}
if (!/spawnNext\(x\)/.test(KB)) throw new Error("kbSet no longer spawns the successor it used to");

const BODY = [
  '"use strict";',
  "let tasks = __tasks;",
  "const store = __store;",
  "const Date = __Date;",
  "const toast = () => {}, digits = (v) => String(v), t = (k) => k;",
  "const renderKanban = () => {}, renderTasks = () => {};",
  CORE,
  KB,
  "return { tasks, isoDay, parseDay, addMonthDay, nextDue, spawnNext, setDone, kbSet, rollOverdue, rollNow, armRollover };"
].join("\n");

/* ── the world ─────────────────────────────────────────────────────────────── */
function makeClock(iso) {
  const Real = globalThis.Date;
  const box = { ms: new Real(iso).getTime() };
  class FakeDate extends Real {
    constructor(...args) { if (args.length === 0) super(box.ms); else super(...args); }
    static now() { return box.ms; }
  }
  box.Date = FakeDate;
  return box;
}
function makeStore() {
  const writes = {};
  return {
    writes,
    set(k, v) { writes[k] = JSON.parse(JSON.stringify(v)); },
    get(k, d) { return k in writes ? writes[k] : d; }
  };
}
function load({ tasks = [], now = "2026-03-15T09:00:00" } = {}) {
  const clock = makeClock(now);
  const store = makeStore();
  const timers = { armed: [], cleared: [] };
  const setTimeout = (fn, ms) => { timers.armed.push({ id: timers.armed.length + 1, fn, ms }); return timers.armed.length; };
  const clearTimeout = (id) => timers.cleared.push(id);
  const api = new Function("__tasks", "__store", "__Date", "setTimeout", "clearTimeout", BODY)(
    tasks, store, clock.Date, setTimeout, clearTimeout
  );
  return Object.assign(api, { clock, store, timers });
}

let n = 0, fails = 0;
const ok = (name, cond, detail) => {
  n++;
  if (!cond) fails++;
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail !== undefined ? "  [" + detail + "]" : ""));
};

/* a card with everything a repeat is supposed to carry */
const card = (over) => Object.assign({
  id: "t1", done: false, status: "todo", text: "Pay VAT", project: "Home", priority: "high",
  resp: "Sam", start: "2026-03-01", due: "2026-03-15", loc: "Office", email: "a@b.c", phone: "055",
  notes: "invoice 9", rep: "daily"
}, over || {});

const kidsOf = (h, parent) => h.tasks.filter((x) => x.from === parent.id);
const weekday = (iso) => new Date(iso + "T12:00:00").getDay();
const days = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
const TODAY = "2026-03-15";

/* ── the successor: one per completion, dated forward ──────────────────────── */
{
  const h = load({ tasks: [card()] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kids = kidsOf(h, parent);

  ok("successor: completing a daily card schedules exactly one successor",
    kids.length === 1 && h.tasks.length === 2, kids.length + " successor(s), " + h.tasks.length + " tasks");
  const kid = kids[0] || {};
  ok("successor: a daily card finished today yields tomorrow",
    kid.due === "2026-03-16", kid.due);
  ok("successor: the new card is open, in the to-do column, and repeats like its parent",
    kid.done === false && kid.status === "todo" && kid.rep === "daily" && kid.from === parent.id,
    [kid.done, kid.status, kid.rep, kid.from].join("/"));
  ok("successor: it carries the card's words - title, client, priority, project, place, contacts, notes",
    kid.text === parent.text && kid.resp === parent.resp && kid.priority === parent.priority
    && kid.project === parent.project && kid.loc === parent.loc && kid.email === parent.email
    && kid.phone === parent.phone && kid.notes === parent.notes,
    kid.text);
  ok("successor: it does not inherit the old start date or a completion stamp",
    kid.start === "" && kid.doneAt === undefined && parent.doneAt !== undefined,
    "start " + JSON.stringify(kid.start) + " · child doneAt " + kid.doneAt);
}

{
  const h = load({ tasks: [card({ due: "2026-03-09" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: a daily card finished a week late yields tomorrow, not another overdue card",
    kid.due === "2026-03-16", kid.due);
}

{
  const h = load({ tasks: [card({ due: "2026-03-05", rep: "weekly" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: weekly keeps its weekday - same day of the week, always in the future",
    kid.due === "2026-03-19" && weekday(kid.due) === weekday("2026-03-05") && kid.due > TODAY,
    kid.due + " (" + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(kid.due || TODAY)] + "), " + days(TODAY, kid.due) + " days out");
}

{
  const h = load({ now: "2026-01-31T09:00:00", tasks: [card({ due: "2026-01-31", rep: "monthly" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: monthly from the 31st lands on the last day of February, not in March",
    kid.due === "2026-02-28", kid.due);
}

{
  const h = load({ now: "2026-12-20T09:00:00", tasks: [card({ due: "2026-12-20", rep: "monthly" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: monthly across New Year rolls the year instead of the month",
    kid.due === "2027-01-20", kid.due);
}

{
  const h = load({ now: "2026-12-31T09:00:00", tasks: [card({ due: "2026-12-31" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: daily across New Year rolls the year", kid.due === "2027-01-01", kid.due);
}

{
  /* a repeat that has been neglected for months must still come out in the future */
  const h = load({ now: "2026-05-20T09:00:00", tasks: [card({ due: "2026-01-31", rep: "monthly" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: a monthly card months overdue still lands once, in the future",
    !!kid.due && kid.due > "2026-05-20" && days("2026-05-20", kid.due) <= 31,
    kid.due + " · " + days("2026-05-20", kid.due || "2026-05-20") + " days out");
}

{
  const h = load({ tasks: [card({ due: "", rep: "daily" })] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("successor: an undated card anchors at today", kid.due === "2026-03-16", kid.due);
}

{
  for (const rep of [undefined, "", "never", "yearly"]) {
    const h = load({ tasks: [card({ rep })] });
    const parent = h.tasks[0];
    h.setDone(parent, true);
    ok("successor: no successor for a card that does not repeat (" + String(rep) + ")",
      h.tasks.length === 1 && h.tasks[0].done === true && kidsOf(h, parent).length === 0,
      h.tasks.length + " tasks");
  }
}

/* ── one successor, however often the card is ticked ───────────────────────── */
{
  const h = load({ tasks: [card()] });
  const parent = h.tasks[0];
  h.setDone(parent, true);
  const after = h.tasks.length;
  h.setDone(parent, true);                       // a second tick while already done
  h.setDone(parent, false); h.setDone(parent, true);   // un-done, then done again
  ok("successor: ticking an already-done card, or undoing and redoing it, cannot duplicate the next one",
    h.tasks.length === after && kidsOf(h, parent).length === 1,
    h.tasks.length + " tasks, " + kidsOf(h, parent).length + " successor(s)");
  ok("spawnNext: the guard itself refuses a second successor for the same parent",
    h.spawnNext(parent) === null && h.tasks.length === after, "returned null: " + (h.spawnNext(parent) === null));
}

{
  const h = load({ tasks: [card()] });
  const parent = h.tasks[0];
  h.setDone(parent, false);
  ok("setDone: un-completing a card spawns nothing and clears its completion stamp",
    h.tasks.length === 1 && parent.doneAt === undefined && parent.done === false,
    h.tasks.length + " tasks · doneAt " + parent.doneAt);
}

/* the board's own path - the drag and the arrow keys - is held to the same rule */
{
  const h = load({ tasks: [card()] });
  const parent = h.tasks[0];
  h.kbSet(parent, "done");
  const kids = kidsOf(h, parent);
  ok("successor: finishing a card from the board spawns the next one too, not only from the list",
    kids.length === 1 && parent.status === "done" && parent.done === true && kids[0].due === "2026-03-16",
    kids.length + " successor(s)");
}

/* ── every completion path goes through the one place that spawns ──────────── */
{
  const doneWrites = page.match(/\.done\s*=(?!=)/g) || [];
  const spawnCalls = (page.match(/spawnNext\(x\)/g) || []).length;   // one definition + two calls
  ok("wiring: only setDone and kbSet write `done`, and both of them spawn the successor",
    doneWrites.length === 2 && spawnCalls === 3, doneWrites.length + " `.done=` sites · " + spawnCalls + " spawnNext references");
  ok("wiring: the list's circle and the board both finish cards through those two functions",
    /setDone\(x,!x\.done\)/.test(page) && /kbSet\(x,col\)/.test(page) && /kbSet\(it,t\.colId\)/.test(page),
    "circle, drag and arrow-key paths");
}

/* ── rollover: once a day, forward only, open cards only ───────────────────── */
{
  const h = load({ tasks: [card({ due: "2026-03-10", rep: "" })] });
  const moved = h.rollOverdue();
  ok("rollover: an open card past its date moves to today",
    moved === 1 && h.tasks[0].due === TODAY, moved + " moved · due " + h.tasks[0].due);
  ok("rollover: the move is counted on the card, so it can say it was carried",
    h.tasks[0].rolled === 1, "rolled " + h.tasks[0].rolled);
  ok("rollover: the moved list is written to storage straight away",
    !!h.store.writes.pd_tasks && h.store.writes.pd_tasks[0].due === TODAY, Object.keys(h.store.writes).join(","));

  const again = h.rollOverdue();
  ok("rollover: a second run the same day moves nothing and does not inflate the count",
    again === 0 && h.tasks[0].rolled === 1 && h.tasks[0].due === TODAY,
    again + " moved · rolled " + h.tasks[0].rolled);
}

{
  const h = load({ tasks: [card({ due: "2026-03-10", done: true })] });
  const before = JSON.stringify(h.tasks[0]);
  const moved = h.rollOverdue();
  ok("rollover: a finished card keeps the date it was finished on",
    moved === 0 && JSON.stringify(h.tasks[0]) === before, moved + " moved · due " + h.tasks[0].due);
}

{
  const h = load({ tasks: [card({ due: "2026-03-20" })] });
  ok("rollover: a future date is left exactly where it is",
    h.rollOverdue() === 0 && h.tasks[0].due === "2026-03-20", h.tasks[0].due);
}

{
  const h = load({ tasks: [card({ due: TODAY })] });
  ok("rollover: a card already dated today is untouched and is not marked carried",
    h.rollOverdue() === 0 && h.tasks[0].due === TODAY && h.tasks[0].rolled === undefined,
    "rolled " + h.tasks[0].rolled);
}

{
  const bad = [{ id: "a", due: "" }, { id: "b", due: "sometime" }, { id: "c", due: "2026-3-9" }, { id: "d" }];
  const h = load({ tasks: bad.map((x) => Object.assign({ done: false, text: "x" }, x)) });
  const before = JSON.stringify(h.tasks);
  const moved = h.rollOverdue();
  ok("rollover: a missing or malformed date is not invented into today",
    moved === 0 && JSON.stringify(h.tasks) === before, moved + " moved");
}

{
  const h = load({ tasks: [card({ due: "2026-03-10T00:00:00" })] });
  ok("rollover: a date that arrives with a time attached still rolls",
    h.rollOverdue() === 1 && h.tasks[0].due === TODAY, h.tasks[0].due);
}

{
  const h = load({ tasks: [card({ due: "2026-03-20" })] });
  h.rollOverdue();
  ok("rollover: nothing is written when nothing moved", Object.keys(h.store.writes).length === 0,
    Object.keys(h.store.writes).length + " writes");
}

{
  const h = load({ tasks: [
    card({ id: "a", due: "2026-03-01" }), card({ id: "b", due: "2026-03-02" }),
    card({ id: "c", due: "2026-03-03" }), card({ id: "d", due: "2026-04-01" })
  ] });
  const moved = h.rollOverdue();
  ok("rollover: every overdue card moves, and only the overdue ones",
    moved === 3 && h.tasks.filter((x) => x.due === TODAY).length === 3 && h.tasks.find((x) => x.id === "d").due === "2026-04-01",
    moved + " moved");
}

{
  const h = load({ tasks: [card({ due: "2026-03-10", rep: "daily" })] });
  const moved = h.rollOverdue();
  const parent = h.tasks[0];
  ok("rollover: a repeating card that was never finished still rolls, and keeps its series",
    moved === 1 && parent.rep === "daily" && parent.due === TODAY && h.tasks.length === 1,
    "due " + parent.due + " · rep " + parent.rep + " · " + h.tasks.length + " tasks");
  h.setDone(parent, true);
  const kid = kidsOf(h, parent)[0] || {};
  ok("rollover: after being carried, finishing it still schedules from the new date",
    kid.due === "2026-03-16", kid.due);
}

{
  const h = load({ tasks: [card({ due: "2026-03-10", rep: "" })] });
  ok("rollover: rollNow applies the same rule and reports the count",
    h.rollNow() === 1 && h.tasks[0].due === TODAY, h.tasks[0].due);
}

/* ── the midnight timer, and the boot wiring ──────────────────────────────── */
{
  const h = load({ now: "2026-03-15T23:58:00", tasks: [] });
  h.armRollover();
  const first = h.timers.armed[0];
  ok("rollover: the timer is armed for just after local midnight, not 24 hours from now",
    !!first && first.ms === 122000, first ? first.ms + "ms" : "no timer");
  first.fn();
  ok("rollover: when midnight fires it rolls, then arms the next midnight",
    h.timers.armed.length === 2 && h.timers.cleared.includes(1),
    h.timers.armed.length + " timers armed · cleared " + JSON.stringify(h.timers.cleared));
}

{
  const boot = page.indexOf("const __rolled=rollOverdue();");
  ok("wiring: rollover runs before the first paint, so a stale date is never drawn",
    boot > 0 && boot < page.indexOf("applyPrefs();buildPages();"), boot > 0 ? "before applyPrefs" : "not found");
  ok("wiring: it also re-runs at local midnight and when the tab comes back",
    /armRollover\(\);/.test(page) && /visibilitychange[\s\S]{0,120}rollNow\(\)/.test(page),
    "midnight timer + visibilitychange");
}

console.log("\n" + (n - fails) + "/" + n + " checks passed");
process.exit(fails ? 1 : 0);
