/* Drives the real weekStats/weekDur/weekSpan source out of index.html with crafted data. */
import fs from "fs";

process.env.TZ = "Asia/Beirut";

const src = fs.readFileSync("index.html", "utf8");
const dayKey = (src.match(/function dkey\(d\)\{[^\n]*\}/) || [])[0];
const weekSrc = (src.match(/function weekSpan\(\)[\s\S]*?\n(?=function renderWeek)/) || [])[0];
if (!dayKey || !weekSrc) throw new Error("could not extract the week source");

const run = (bundle) => new Function(
  "tasks", "habits", "fstate", "settings", "digits", "t", "dkey",
  dayKey + "\n" + weekSrc + "\nreturn { weekStats: weekStats, weekDur: weekDur, weekSpan: weekSpan, weekKeys: weekKeys };"
)(bundle.tasks || [], bundle.habits || [], bundle.fstate || {}, bundle.settings || { weekSpan: 7 },
  (s) => String(s), (k) => k, (d) => {
    const x = new Date(d);
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  });

const today = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })();
const key = (offset) => { const d = new Date(today); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isoNoon = (offset) => { const d = new Date(today); d.setDate(d.getDate() + offset); d.setHours(12, 0, 0, 0); return d.toISOString(); };

let fails = 0, n = 0;
const ok = (name, cond, detail) => { n++; if (!cond) fails++; console.log((cond ? "PASS  " : "FAIL  ") + name + (detail !== undefined ? "  [" + detail + "]" : "")); };

/* ── completion rate: only cards dated inside the window are the denominator ── */
{
  const tasks = [
    { text: "due yesterday, done today", due: key(-1), done: true, doneAt: isoNoon(0) },
    { text: "due two days ago, open", due: key(-2), done: false },
    { text: "due today, open", due: key(0), done: false },
    { text: "due 10 days ago, outside a week", due: key(-10), done: true },
    { text: "due in two days, closed early", due: key(2), done: true, doneAt: isoNoon(0) },
    { text: "undated", done: false },
  ];
  const w = run({ tasks });
  const s = w.weekStats(7);
  ok("7-day: denominator is the 3 dated cards in the window", s.due === 3, "due=" + s.due);
  ok("7-day: one of them is done", s.dueDone === 1, "done=" + s.dueDone + " rate=" + Math.round(s.dueDone / s.due * 100) + "%");
  ok("7-day: two closed today (one due yesterday, one due later)", s.closed === 2, "closed=" + s.closed);
  ok("7-day: bars land on today only", s.perDay[key(0)] === 2 && s.perDay[key(-1)] === 0, JSON.stringify(s.perDay));
  const t30 = w.weekStats(30);
  ok("30-day: the older card joins the denominator", t30.due === 4, "due=" + t30.due);
  ok("30-day: two of the four are done (yesterday and the 10-days-ago card)", t30.dueDone === 2, "done=" + t30.dueDone + "/" + t30.due);
  ok("30-day: 30 bars, one per day", t30.keys.length === 30 && Object.keys(t30.perDay).length === 30, t30.keys.length + " keys");
}

/* ── window edges: the first day counts, the day before does not; nothing from the future ── */
{
  const keys = run({}).weekKeys(7);
  const tasks = [
    { due: keys[0], done: false },
    { due: key(-7), done: false },
    { due: key(1), done: false },
  ];
  const s = run({ tasks }).weekStats(7);
  ok("first day of the window is inside it, the day before is not, tomorrow is not",
    s.due === 1, "due=" + s.due + " from=" + keys[0] + " before=" + key(-7) + " tomorrow=" + key(1));
}

/* ── doneAt is a timestamp: the LOCAL day decides, not the UTC day ── */
{
  /* Local 01:30 yesterday is still the *previous* UTC day in Beirut (+3), so a naive
     slice(0,10) of the ISO string would file it under the wrong day. */
  const earlyYesterdayLocal = (() => { const d = new Date(today); d.setDate(d.getDate() - 1); d.setHours(1, 30, 0, 0); return d.toISOString(); })();
  const s = run({ tasks: [{ due: key(-1), done: true, doneAt: earlyYesterdayLocal }] }).weekStats(7);
  ok("a completion just after local midnight sits on the local day, not the UTC one",
    s.perDay[key(-1)] === 1 && s.perDay[key(-2)] === 0 && s.closed === 1,
    "local yesterday=" + s.perDay[key(-1)] + " the day before=" + s.perDay[key(-2)] + " · UTC day would be " + earlyYesterdayLocal.slice(0, 10));
}

/* ── legacy: done with no timestamp is honest about it ── */
{
  const tasks = [
    { due: key(-2), done: true },
    { due: key(-1), done: true, doneAt: isoNoon(-1) },
  ];
  const s = run({ tasks }).weekStats(7);
  ok("a completion without a timestamp still counts as met", s.due === 2 && s.dueDone === 2, s.dueDone + "/" + s.due);
  ok("…but is not dated to its due day in the bars", s.closed === 1, "closed=" + s.closed);
  ok("…and is counted for the note", s.legacy === 1, "legacy=" + s.legacy);
}

/* ── un-done clears the timestamp: no ghost closures ── */
{
  const tasks = [{ due: key(-1), done: false, doneAt: isoNoon(-1) }];
  const s = run({ tasks }).weekStats(7);
  ok("an open card with a stale timestamp is not counted as closed", s.closed === 0 && s.perDay[key(-1)] === 0, "closed=" + s.closed);
  ok("…and still sits in the denominator", s.due === 1 && s.dueDone === 0, s.dueDone + "/" + s.due);
}

/* ── focus minutes ── */
{
  const fstate = { sessions: { [key(0)]: 2, [key(-1)]: 1 }, mins: { [key(0)]: 50, [key(-1)]: 25 } };
  const s = run({ fstate }).weekStats(7);
  ok("minutes add up across the window", s.mins === 75, "mins=" + s.mins);
  ok("sessions add up across the window", s.sess === 3, "sess=" + s.sess);
  const legacy = run({ fstate: { sessions: { [key(0)]: 3 } } }).weekStats(7);
  ok("sessions recorded before minutes existed leave mins at 0, not an invented figure", legacy.mins === 0 && legacy.sess === 3, "mins=" + legacy.mins + " sess=" + legacy.sess);
  const labels = { wkMin: "m", wkHour: "h" };
  const w = new Function("tasks", "habits", "fstate", "settings", "digits", "t", "dkey",
    dayKey + "\n" + weekSrc + "\nreturn { weekDur: weekDur };")([], [], {}, { weekSpan: 7 }, (s) => String(s), (k) => labels[k] || k, () => "");
  ok("duration wording: 0m, 45m, 3h, 3h 20m",
    w.weekDur(0) === "0m" && w.weekDur(45) === "45m" && w.weekDur(180) === "3h" && w.weekDur(200) === "3h 20m",
    [w.weekDur(0), w.weekDur(45), w.weekDur(180), w.weekDur(200)].join(" / "));
}

/* ── habit adherence: days before a habit existed are not failures ── */
{
  const born = new Date(today); born.setDate(born.getDate() - 3); born.setHours(9, 0, 0, 0);
  const habits = [
    { id: "a", name: "born 3 days ago", ts: born.getTime(), days: { [key(0)]: true, [key(-1)]: true, [key(-3)]: true } },
    { id: "b", name: "no timestamp", days: { [key(0)]: true } },
  ];
  const s = run({ habits }).weekStats(7);
  ok("a habit only owes days since it was created", s.hMax === 4 + 7, "hMax=" + s.hMax + " (4 for the young habit, 7 for the untimed one)");
  ok("checks inside the window are counted", s.hDone === 4, "hDone=" + s.hDone);
  const checked = run({ habits: [{ id: "c", ts: born.getTime(), days: { [key(0)]: true, [key(-1)]: true, [key(-2)]: true, [key(-3)]: true } }] }).weekStats(7);
  ok("a perfect young habit reads 100%, not 57%", checked.hDone === 4 && checked.hMax === 4, checked.hDone + "/" + checked.hMax);
  const old = run({ habits: [{ id: "d", ts: born.getTime(), days: { [key(-5)]: true } }] }).weekStats(7);
  ok("a check before the habit existed is not credited", old.hDone === 0, "hDone=" + old.hDone);
  const none = run({}).weekStats(7);
  ok("no habits at all is an empty denominator, not 0%", none.hMax === 0, "hMax=" + none.hMax);
}

/* ── the window setting is clamped to the two buttons the card draws ── */
{
  const span = (v) => run({ settings: v === undefined ? {} : { weekSpan: v } }).weekSpan();
  ok("weekSpan: 30 stays 30, anything else is a 7", span(30) === 30 && span(7) === 7 && span(undefined) === 7 && span(90) === 7 && span("30") === 30,
    [30, 7, undefined, 90, "30"].map(span).join(","));
}

/* ── nothing logged is an honest empty, not a division by zero ── */
{
  const s = run({}).weekStats(7);
  ok("an empty store reports zeros and nulls a caller can turn into —",
    s.due === 0 && s.dueDone === 0 && s.closed === 0 && s.sess === 0 && s.hMax === 0 && s.legacy === 0,
    JSON.stringify(s).slice(0, 120));
}

console.log("\n" + (n - fails) + "/" + n + " checks passed");
process.exit(fails ? 1 : 0);
