/*
 * Read-only viewer for the static site. Fetches data.json (ciphertext), derives the key from the password with
 * PBKDF2-SHA256 and decrypts with AES-256-GCM in this browser (the same steps as src/lib/pages-crypto.ts), then draws
 * the app's pages. Everything can be explored (periods, switches, drill-downs, filters, what-if assumptions) but
 * nothing can be entered, uploaded or downloaded, and nothing is saved: locking or closing the page forgets it all.
 * The forecast and the property and car estimates use the app's own code (lib.js, window.FinLib).
 */
"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GROUPS = ["Property and home", "Food and drink", "Transport", "Shopping", "Health and wellbeing", "Lifestyle and entertainment", "Travel", "Bills, fees and work", "Other"];
const groupColour = (g) => `var(--g${Math.min(GROUPS.indexOf(g) + 1 || 9, 9)})`;
const CLASS_COLOUR = {
  Cash: "var(--g1)",
  Offset: "var(--g2)",
  "Shares and ETFs": "var(--g3)",
  Super: "var(--g4)",
  Property: "var(--g7)",
  Vehicles: "var(--g9)",
};
const BUCKET_COLOUR = {
  Income: "var(--g6)",
  Home: "var(--g1)",
  Variable: "var(--g2)",
  Car: "var(--g3)",
  Other: "var(--g4)",
  Investment: "var(--g7)",
  Debt: "var(--g8)",
  Surplus: "var(--g9)",
  Shortfall: "var(--g9)",
};
const NOT_SPENDING = new Set(["Investment", "Transfer", "Debt", "Income"]);

// ---------- formatting ----------
let PCT = false; // "Percent only": dollar figures are hidden and charts that can show shares do.
const aud = (cents, digits = 0) =>
  (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const audK = (cents) => {
  const v = Math.abs(cents) / 100;
  const s = v >= 1e6 ? `$${(v / 1e6).toFixed(2)}m` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k` : `$${v.toFixed(0)}`;
  return cents < 0 ? `-${s}` : s;
};
const pct = (v, d = 1) => (v == null || !isFinite(v) ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const share = (v, base) => (base ? `${((v / base) * 100).toFixed(Math.abs(v / base) < 0.1 ? 1 : 0)}%` : "–");
const tone = (v) => (v == null ? "muted" : v >= 0 ? "pos" : "neg");
const date = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const monthLabel = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;
const monthLong = (ym) => `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const addMonthsIso = (iso, n) => {
  const [y, m] = iso.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
};
const lastDay = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

// ---------- DOM helpers (textContent only; styles through the CSSOM, which the page's policy allows) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
const money = (cents, cls = "") => h("span", { class: `num ${cls}` }, aud(cents));
const card = (title, sub, ...body) => h("section", { class: "card" }, h("div", { class: "head" }, h("h2", {}, title), sub ? h("p", {}, sub) : null), h("div", { class: "body" }, ...body));
const cardWith = (title, sub, action, ...body) =>
  h("section", { class: "card" }, h("div", { class: "head row" }, h("div", {}, h("h2", {}, title), sub ? h("p", {}, sub) : null), action), h("div", { class: "body" }, ...body));
const tile = (label, value, note) => h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value num" }, value), note ? h("div", { class: "note" }, note) : null);
const legend = (items) => h("div", { class: "legend" }, items.map(([label, colour, line]) => h("span", {}, h("i", { class: line ? "line" : "", style: { background: colour } }), label)));
const empty = (text) => h("p", { class: "muted" }, text);

/** Pills (period and view choices). */
function pills(options, current, onPick, label) {
  return h(
    "div",
    { class: "pills", role: "group", "aria-label": label },
    options.map(([id, text]) => h("button", { type: "button", class: `pill ${id === current ? "on" : ""}`, "aria-pressed": String(id === current), onclick: () => onPick(id) }, text)),
  );
}
/** A two-way switch, as the app's ("Left out" / "Counted"). */
function seg(label, options, current, onPick) {
  return h(
    "div",
    { class: "switch" },
    h("span", { class: "muted" }, label),
    h(
      "div",
      { class: "seg", role: "group", "aria-label": label },
      options.map(([id, text]) => h("button", { type: "button", class: id === current ? "on" : "", "aria-pressed": String(id === current), onclick: () => onPick(id) }, text)),
    ),
  );
}
const table = (heads, rows, rightFrom = 99) =>
  h(
    "div",
    { class: "scroll" },
    h("table", {}, heads ? h("thead", {}, h("tr", {}, heads.map((t, i) => h("th", { class: i >= rightFrom ? "r" : "" }, t)))) : null, h("tbody", {}, rows)),
  );

// ---------- decrypt ----------
const unb64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
async function open(sealed, password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(sealed.salt), iterations: sealed.iterations }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- charts (one axis each; hover shows the figure) ----------
function frame(W, H, label) {
  return s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
}
function yAxis(svg, Y, lo, hi, pad, W, fmt = audK) {
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }), s("text", { class: "axis", x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
}
function xLabels(svg, xs, X, H, fmt, max = 8) {
  const step = Math.ceil(xs.length / max);
  xs.forEach((x, i) => {
    if (i % step === 0 || i === xs.length - 1) svg.append(s("text", { x: X(i), y: H - 6, "text-anchor": i === xs.length - 1 ? "end" : i === 0 ? "start" : "middle" }, fmt(x)));
  });
}

function lineChart(series, { height = 240, fmt = audK, xFmt = monthLabel, title = date } = {}) {
  const W = 760;
  const H = height;
  const pad = { l: 58, r: 12, t: 10, b: 24 };
  const xs = series[0].points.map((p) => p.x);
  const all = series.flatMap((sr) => sr.points.map((p) => p.y)).filter((v) => v != null);
  const lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const X = (i) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, xs.length - 1);
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const svg = frame(W, H, series.map((x) => x.label).join(", "));
  yAxis(svg, Y, lo, hi, pad, W, fmt);
  xLabels(svg, xs, X, H, xFmt);
  for (const sr of series) {
    const d = sr.points.map((p, i) => (p.y == null ? "" : `${i && sr.points[i - 1]?.y != null ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`)).join("");
    svg.append(s("path", { d, fill: "none", stroke: sr.colour, "stroke-width": 2, "stroke-dasharray": sr.dashed ? "5 4" : null }));
  }
  xs.forEach((x, i) => {
    const w = (W - pad.l - pad.r) / Math.max(1, xs.length - 1);
    svg.append(s("rect", { x: X(i) - w / 2, y: pad.t, width: w, height: H - pad.t - pad.b, fill: "transparent" }, s("title", {}, `${title(x)}\n${series.map((sr) => `${sr.label}: ${sr.points[i].y == null ? "–" : fmt(sr.points[i].y)}`).join("\n")}`)));
  });
  return svg;
}

function stackedBars(rows, keys, colourOf, { height = 240, label = "By month" } = {}) {
  const W = 760;
  const H = height;
  const pad = { l: 58, r: 8, t: 10, b: 24 };
  const totals = rows.map((r) => keys.reduce((a, k) => a + Math.max(0, r[k] || 0), 0));
  const hi = Math.max(1, ...totals);
  const bw = (W - pad.l - pad.r) / Math.max(1, rows.length);
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / hi;
  const svg = frame(W, H, label);
  yAxis(svg, Y, 0, hi, pad, W);
  rows.forEach((r, i) => {
    let base = 0;
    const x = pad.l + i * bw + bw * 0.18;
    for (const k of keys) {
      const v = Math.max(0, r[k] || 0);
      if (!v) continue;
      const y1 = Y(base + v);
      const y0 = Y(base);
      svg.append(s("rect", { x, y: y1, width: bw * 0.64, height: Math.max(0, y0 - y1 - 2), rx: 2, fill: colourOf(k) }, s("title", {}, `${monthLabel(r.month)} · ${k}: ${aud(v)}`)));
      base += v;
    }
    svg.append(s("text", { x: x + bw * 0.32, y: H - 6, "text-anchor": "middle" }, monthLabel(r.month)));
  });
  return svg;
}

function groupedBars(rows, series, { height = 220, line = null } = {}) {
  const W = 760;
  const H = height;
  const pad = { l: 58, r: 8, t: 10, b: 24 };
  const vals = rows.flatMap((r) => [...series.map((sr) => r[sr.key]), line ? r[line.key] : 0]);
  const hi = Math.max(1, ...vals);
  const lo = Math.min(0, ...vals);
  const bw = (W - pad.l - pad.r) / Math.max(1, rows.length);
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const svg = frame(W, H, series.map((x) => x.label).join(" against "));
  yAxis(svg, Y, lo, hi, pad, W);
  const each = (bw * 0.7) / series.length;
  rows.forEach((r, i) => {
    series.forEach((sr, j) => {
      const v = r[sr.key];
      const x = pad.l + i * bw + bw * 0.15 + j * each;
      svg.append(s("rect", { x, y: Math.min(Y(v), Y(0)), width: Math.max(1, each - 2), height: Math.abs(Y(0) - Y(v)), rx: 2, fill: sr.colour }, s("title", {}, `${monthLabel(r.month)} · ${sr.label}: ${aud(v)}`)));
    });
    svg.append(s("text", { x: pad.l + i * bw + bw / 2, y: H - 6, "text-anchor": "middle" }, monthLabel(r.month)));
  });
  if (line) {
    const d = rows.map((r, i) => `${i ? "L" : "M"}${(pad.l + i * bw + bw / 2).toFixed(1)},${Y(r[line.key]).toFixed(1)}`).join("");
    svg.append(s("path", { d, fill: "none", stroke: line.colour, "stroke-width": 2 }));
    rows.forEach((r, i) => svg.append(s("circle", { cx: pad.l + i * bw + bw / 2, cy: Y(r[line.key]), r: 4, fill: line.colour, stroke: "var(--surface)", "stroke-width": 2 }, s("title", {}, `${monthLabel(r.month)} · ${line.label}: ${aud(r[line.key])}`))));
  }
  return svg;
}

/** Assets stacked above zero, debts below, net worth as a line. */
function stackedArea(history, assetKeys, debtKeys) {
  const W = 760;
  const H = 300;
  const pad = { l: 58, r: 12, t: 10, b: 24 };
  const xs = history.map((p) => p.date);
  const up = history.map((p) => assetKeys.reduce((a, k) => a + Math.max(0, p.assets[k] || 0), 0));
  const down = history.map((p) => debtKeys.reduce((a, k) => a + Math.min(0, p.liabilities[k] || 0), 0));
  const hi = Math.max(1, ...up);
  const lo = Math.min(0, ...down);
  const X = (i) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, xs.length - 1);
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const svg = frame(W, H, "Net worth by class");
  yAxis(svg, Y, lo, hi, pad, W);
  xLabels(svg, xs, X, H, monthLabel);
  const band = (values0, values1, colour, opacity, name) => {
    const top = values1.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const bottom = values0.map((_, i) => `L${X(values0.length - 1 - i).toFixed(1)},${Y(values0[values0.length - 1 - i]).toFixed(1)}`).join("");
    svg.append(s("path", { d: `${top}${bottom}Z`, fill: colour, "fill-opacity": opacity, stroke: "var(--surface)", "stroke-width": 1 }, s("title", {}, name)));
  };
  let base = history.map(() => 0);
  for (const k of assetKeys) {
    const next = history.map((p, i) => base[i] + Math.max(0, p.assets[k] || 0));
    band(base, next, CLASS_COLOUR[k] ?? "var(--g9)", 0.85, k);
    base = next;
  }
  base = history.map(() => 0);
  for (const k of debtKeys) {
    const next = history.map((p, i) => base[i] + Math.min(0, p.liabilities[k] || 0));
    band(base, next, "var(--g8)", 0.45, `${k} (owed)`);
    base = next;
  }
  svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(0), y2: Y(0), stroke: "var(--border-strong)" }));
  svg.append(s("path", { d: history.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.netWorth).toFixed(1)}`).join(""), fill: "none", stroke: "var(--text)", "stroke-width": 2 }));
  svg.append(s("path", { d: history.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.accessible).toFixed(1)}`).join(""), fill: "none", stroke: "var(--text)", "stroke-width": 2, "stroke-dasharray": "5 4" }));
  xs.forEach((x, i) => {
    const w = (W - pad.l - pad.r) / Math.max(1, xs.length - 1);
    const p = history[i];
    const lines = [...assetKeys.filter((k) => p.assets[k]).map((k) => `${k}: ${aud(p.assets[k])}`), ...debtKeys.filter((k) => p.liabilities[k]).map((k) => `${k}: ${aud(p.liabilities[k])}`)];
    svg.append(s("rect", { x: X(i) - w / 2, y: pad.t, width: w, height: H - pad.t - pad.b, fill: "transparent" }, s("title", {}, `${date(x)}\nNet worth: ${aud(p.netWorth)}\n${lines.join("\n")}`)));
  });
  return svg;
}

/** Estimate, likely range and the recorded value on one line. */
function valueBand(v) {
  const pts = [v.low, v.high, v.estimate, v.recorded ?? v.estimate, ...(v.adjusted || []).filter((c) => c.used).map((c) => c.adjusted)];
  const lo = Math.min(...pts) * 0.97;
  const hi = Math.max(...pts) * 1.03;
  const at = (x) => `${(((x - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  return h(
    "div",
    { class: "band", role: "img", "aria-label": `Estimate ${aud(v.estimate)}, likely ${aud(v.low)} to ${aud(v.high)}` },
    h("span", { class: "shade", style: { left: at(v.low), right: `calc(100% - ${at(v.high)})` } }),
    (v.adjusted || []).filter((c) => c.used).map((c) => h("span", { class: "dotm", title: `${c.label}: ${aud(c.adjusted)} today`, style: { left: at(c.adjusted) } })),
    h("span", { class: "tick", style: { left: at(v.estimate) } }),
    v.recorded != null ? h("span", { class: "mine", style: { left: at(v.recorded) } }) : null,
  );
}

// ---------- shared data helpers ----------
let DATA = null;
const isSpending = (t) => !t.transfer && !["transfer", "loan_repayment", "investment"].includes(t.kind) && !NOT_SPENDING.has(t.bucket ?? "Other") && !(t.amount > 0 && !t.category);
const inRange = (t, from, to) => t.date >= from && t.date <= to;
/** The ten largest transactions behind a profit and loss box, from the transaction list. */
function driversFor(node, from, to) {
  const cats = new Set(node.lines.map((l) => l.category));
  const income = node.group === "Income";
  return DATA.transactions
    .filter((t) => inRange(t, from, to) && cats.has(t.category ?? (income ? "Uncategorised income" : "Uncategorised")) && (income ? t.amount > 0 : t.amount < 0))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 10);
}
const txnRow = (t) =>
  h(
    "tr",
    {},
    h("td", { class: "nowrap" }, date(t.date)),
    h(
      "td",
      {},
      t.description,
      t.pending ? h("span", { class: "badge" }, "Pending") : null,
      t.transfer ? h("span", { class: "badge" }, "Transfer") : null,
      t.exceptional ? h("span", { class: "badge warn" }, "Exceptional") : null,
      t.detail ? h("span", { class: "sub" }, t.detail) : null,
    ),
    h("td", {}, t.account),
    h("td", {}, t.transfer ? h("span", { class: "muted" }, "Between your accounts") : t.category || h("span", { class: "muted" }, "Not categorised")),
    h("td", { class: `r nowrap ${t.amount < 0 ? "neg" : "pos"}` }, h("span", { class: "num" }, `${t.amount > 0 ? "+" : ""}${aud(t.amount, 2)}`)),
  );
/** A paged list of transactions (200 at a time). */
function txnList(rows) {
  const body = h("tbody");
  const more = h("button", { type: "button", class: "ghost" }, "Show more");
  let shown = 200;
  const draw = () => {
    body.replaceChildren(...rows.slice(0, shown).map(txnRow));
    more.hidden = rows.length <= shown;
  };
  more.addEventListener("click", () => ((shown += 200), draw()));
  draw();
  return h("div", {}, h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Date", "Description", "Account", "Category", "Amount"].map((t, i) => h("th", { class: i === 4 ? "r" : "" }, t)))), body)), h("div", { class: "more" }, more));
}
/** Profit and loss variant for a period and the three switches. */
const pnlOf = (key, st) => DATA.pnl.variants[key]?.[`${st.transfers ? 1 : 0}${st.refunds ? 1 : 0}${st.exceptional ? 1 : 0}`];

// ---------- tabs ----------
const TABS = [
  ["overview", "Home"],
  ["networth", "Net worth"],
  ["spending", "Spending"],
  ["pnl", "Profit and loss"],
  ["transactions", "Transactions"],
  ["exceptional", "Exceptional items"],
  ["tracker", "Asset tracker"],
  ["forecast", "Forecast"],
  ["tax", "Tax return"],
  ["bills", "Bills"],
];
// What you have chosen on each page, kept while the page is open (never stored).
const UI = {
  spending: { period: "3m", group: null, category: null, merchant: null, q: "", exceptional: false },
  pnl: { period: "12m", transfers: false, refunds: false, exceptional: false },
  transactions: { view: "all", q: "", account: "", category: "", from: "", to: "", sort: "date" },
  tracker: { period: "1Y", growth: null, discount: null },
  forecast: { a: null, today: true },
  tax: { fy: null },
};

function nav(active) {
  $("tabs").replaceChildren(...TABS.map(([id, label]) => h("a", { href: `#${id}`, class: id === active ? "on" : "", "aria-current": id === active ? "page" : null }, label)));
}
let CURRENT = "overview";
function route() {
  if (!DATA) return;
  const id = (location.hash || "#overview").slice(1);
  CURRENT = TABS.some(([t]) => t === id) ? id : "overview";
  nav(CURRENT);
  redraw(false);
}
function redraw(keepScroll = true) {
  const y = window.scrollY;
  const c = $("content");
  c.replaceChildren();
  PAGES[CURRENT](c, DATA);
  window.scrollTo(0, keepScroll ? y : 0);
}

// ---------- Home ----------
function overview(c, d) {
  const nw = d.netWorth;
  const first = nw.history.find((p) => p.date >= addMonthsIso(d.asOf, -12).slice(0, 10)) ?? nw.history[0];
  const month = d.asOf.slice(0, 7);
  const thisMonth = d.pnl.variants[month]?.["000"];
  const lastMonth = d.pnl.variants[addMonthsIso(d.asOf, -1).slice(0, 7)]?.["000"];
  const review = d.transactions.filter((t) => t.review || (!t.category && !t.transfer)).length;
  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Net worth", aud(nw.current), first ? `${aud(nw.current - first.netWorth)} since ${date(first.date)} · accessible ${audK(nw.accessible)}` : null),
      tile(`Profit and loss, ${monthLong(month)}`, thisMonth ? aud(thisMonth.totals.net) : "–", thisMonth ? `In ${audK(thisMonth.totals.income)} · out ${audK(thisMonth.totals.costs)}${lastMonth ? ` · last month ${aud(lastMonth.totals.net)}` : ""}` : null),
      tile("To review", String(review), "Transactions without a category"),
    ),
    card(
      "Net worth",
      "Month ends; the last point is today. The dashed line leaves out super and property.",
      legend([
        ["Net worth", "var(--text)", true],
        ["Accessible wealth", "var(--accent)", true],
      ]),
      lineChart([
        { label: "Net worth", colour: "var(--text)", points: nw.history.map((p) => ({ x: p.date, y: p.netWorth })) },
        { label: "Accessible wealth", colour: "var(--accent)", dashed: true, points: nw.history.map((p) => ({ x: p.date, y: p.accessible })) },
      ]),
    ),
    h(
      "div",
      { class: "grid2" },
      card("Next bills", "Expected from your history.", d.bills.length ? table(null, d.bills.slice(0, 6).map((b) => h("tr", {}, h("td", {}, b.name, h("span", { class: "sub" }, date(b.expected))), h("td", { class: "r" }, money(Math.abs(b.amount)))))) : empty("None expected.")),
      card("Accounts", "Balances from your statements; account numbers removed.", table(null, d.accounts.map((a) => h("tr", {}, h("td", {}, a.name), h("td", { class: "r" }, money(a.balance, a.balance < 0 ? "neg" : "")))))),
    ),
  );
}

// ---------- Net worth ----------
function networth(c, d) {
  const nw = d.netWorth;
  const assetKeys = Object.keys(CLASS_COLOUR).filter((k) => nw.history.some((p) => p.assets[k]));
  const debtKeys = [...new Set(nw.history.flatMap((p) => Object.keys(p.liabilities)))];
  const assets = Object.values(nw.assets).reduce((a, b) => a + b, 0);
  const debts = Object.values(nw.liabilities).reduce((a, b) => a + b, 0);
  const prev = nw.history[nw.history.length - 2];
  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Net worth today", aud(nw.current), prev ? `${aud(nw.current - prev.netWorth)} since ${date(prev.date)}` : null),
      tile("Accessible wealth", aud(nw.accessible), "Cash, offset and shares"),
      tile("Assets", aud(assets)),
      tile("Liabilities", aud(debts)),
    ),
    card(
      "Net worth over time",
      "Each point is a month end; the last point is today. Debts are drawn below zero.",
      legend([...assetKeys.map((k) => [k, CLASS_COLOUR[k]]), ...debtKeys.map((k) => [`${k} (owed)`, "var(--g8)"]), ["Net worth", "var(--text)", true]]),
      stackedArea(nw.history, assetKeys, debtKeys),
    ),
    card(
      "Today, by class",
      `As at ${date(d.asOf)}.`,
      table(null, [...Object.entries(nw.assets), ...Object.entries(nw.liabilities)].filter(([, v]) => v).map(([k, v]) => h("tr", {}, h("td", {}, k, v < 0 ? h("span", { class: "badge" }, "liability") : null), h("td", { class: "r num" }, share(Math.abs(v), assets)), h("td", { class: "r" }, money(v))))),
    ),
    card(
      "Month by month",
      null,
      table(
        ["Month end", "Net worth", "Accessible", "Change"],
        [...nw.history].reverse().map((p, i, arr) => h("tr", {}, h("td", {}, date(p.date)), h("td", { class: "r" }, money(p.netWorth)), h("td", { class: "r" }, money(p.accessible)), h("td", { class: `r ${arr[i + 1] ? tone(p.netWorth - arr[i + 1].netWorth) : ""}` }, arr[i + 1] ? money(p.netWorth - arr[i + 1].netWorth) : "–"))),
        1,
      ),
    ),
  );
}

// ---------- Spending (drilled from the transaction list) ----------
function spendRange(period, today) {
  const ms = `${today.slice(0, 7)}-01`;
  const fyStart = Number(today.slice(5, 7)) >= 7 ? `${today.slice(0, 4)}-07-01` : `${Number(today.slice(0, 4)) - 1}-07-01`;
  if (period === "last") return [addMonthsIso(ms, -1), lastDay(addMonthsIso(ms, -1).slice(0, 7))];
  if (period === "3m") return [addMonthsIso(ms, -2), today];
  if (period === "fy") return [fyStart, today];
  if (period === "12m") return [addMonthsIso(ms, -11), today];
  return [ms, today];
}
function spending(c, d) {
  const st = UI.spending;
  const [from, to] = spendRange(st.period, d.asOf);
  const needle = st.q.trim().toLowerCase();
  const base = d.transactions.filter((t) => isSpending(t) && (!st.exceptional || !t.exceptional));
  const inPeriod = base.filter((t) => inRange(t, from, to));
  const g = (t) => t.group ?? "Other";
  const cat = (t) => t.category ?? "Uncategorised";
  const match = (t) =>
    (!st.group || g(t) === st.group) &&
    (!st.category || cat(t) === st.category) &&
    (!st.merchant || t.merchant === st.merchant) &&
    (!needle || `${t.merchant} ${t.description} ${cat(t)} ${t.detail ?? ""}`.toLowerCase().includes(needle));
  const rows = inPeriod.filter(match);
  const spent = (list) => list.reduce((a, t) => a - t.amount, 0);
  const total = spent(rows);
  const allTotal = spent(inPeriod);
  const level = st.merchant ? 3 : st.category ? 2 : st.group ? 1 : 0;
  const keyOf = [g, cat, (t) => t.merchant][Math.min(level, 2)];
  const set = (patch) => {
    Object.assign(UI.spending, patch);
    redraw();
  };
  const months12 = [];
  for (let i = 11; i >= 0; i--) months12.push(addMonthsIso(`${d.asOf.slice(0, 7)}-01`, -i).slice(0, 7));
  const monthsIn = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

  const search = h("input", { type: "search", value: st.q, placeholder: "Search merchants and categories (e.g. uber, parking)", "aria-label": "Search spending" });
  search.addEventListener("change", () => set({ q: search.value }));
  c.append(
    pills(
      [
        ["month", "This month"],
        ["last", "Last month"],
        ["3m", "3 months"],
        ["fy", "This financial year"],
        ["12m", "12 months"],
      ],
      st.period,
      (p) => set({ period: p }),
      "Period",
    ),
    h(
      "div",
      { class: "controls" },
      seg(
        "Exceptional items",
        [
          ["in", "Included"],
          ["out", "Left out"],
        ],
        st.exceptional ? "out" : "in",
        (v) => set({ exceptional: v === "out" }),
      ),
      h("div", { class: "filters grow" }, search),
    ),
  );

  // Where you are, and the way back up.
  const crumbs = [["All spending", { group: null, category: null, merchant: null }]];
  if (st.group) crumbs.push([st.group, { category: null, merchant: null }]);
  if (st.category) crumbs.push([st.category, { merchant: null }]);
  if (st.merchant) crumbs.push([st.merchant, {}]);
  c.append(
    h(
      "nav",
      { class: "crumbs", "aria-label": "Drill-down" },
      crumbs.map(([label, patch], i) => [i ? h("span", { class: "muted" }, " › ") : null, i < crumbs.length - 1 ? h("button", { type: "button", class: "link", onclick: () => set(patch) }, label) : h("strong", {}, label)]),
    ),
    h(
      "div",
      { class: "tiles" },
      tile(st.group || st.category || st.merchant || needle ? "Spent here" : "Spent", aud(total), `${date(from)} to ${date(to)}${allTotal && total !== allTotal ? ` · ${share(total, allTotal)} of all spending` : ""}`),
      tile("Transactions", String(rows.length), rows.length ? `average ${aud(total / rows.length)}` : null),
      tile("A month", aud(total / Math.max(1, monthsIn))),
    ),
  );

  // The next level down: groups, then categories, then merchants (click to go in).
  if (level < 3) {
    const by = new Map();
    for (const t of rows) {
      const k = keyOf(t);
      const e = by.get(k) ?? { name: k, amount: 0, count: 0, group: g(t) };
      e.amount -= t.amount;
      e.count++;
      by.set(k, e);
    }
    const list = [...by.values()].filter((e) => e.amount !== 0).sort((a, b) => b.amount - a.amount);
    const max = Math.max(1, ...list.map((e) => e.amount));
    const go = (e) => (level === 0 ? { group: e.name } : level === 1 ? { category: e.name } : { merchant: e.name });
    c.append(
      card(
        ["By group", "By category", "By merchant"][level],
        "Click a row to see what is inside it.",
        list.length
          ? h(
              "div",
              { class: "bars" },
              list.slice(0, 60).map((e) =>
                h(
                  "button",
                  { type: "button", class: "barrow", onclick: () => set(go(e)) },
                  h("span", { class: "bname" }, e.name, h("span", { class: "sub" }, `${e.count} transaction${e.count === 1 ? "" : "s"}`)),
                  h("span", { class: "btrack" }, h("span", { class: "bfill", style: { width: `${Math.max(0, (e.amount / max) * 100).toFixed(1)}%`, background: groupColour(e.group) } })),
                  h("span", { class: "r num" }, aud(e.amount)),
                  h("span", { class: "r muted pctcol" }, share(e.amount, total)),
                ),
              ),
            )
          : empty("No spending here in this period."),
      ),
    );
  }

  // Twelve months of the same selection, by group.
  const keys = GROUPS.filter((gr) => base.some((t) => g(t) === gr && match(t)));
  const series = months12.map((m) => Object.fromEntries([["month", `${m}-01`], ...keys.map((gr) => [gr, -base.filter((t) => t.date.startsWith(m) && g(t) === gr && match(t)).reduce((a, t) => a + t.amount, 0)])]));
  c.append(card("Last 12 months", "The same selection, month by month.", legend(keys.map((k) => [k, groupColour(k)])), stackedBars(series, keys, groupColour)));

  // Expenses against cash: income and costs from profit and loss, each month.
  if (!st.group && !st.category && !st.merchant && !needle) {
    const cash = months12
      .map((m) => ({ m, p: d.pnl.variants[m]?.[`00${st.exceptional ? 1 : 0}`] }))
      .filter((x) => x.p)
      .map((x) => ({ month: `${x.m}-01`, cashIn: x.p.totals.income, expenses: x.p.totals.costs, left: x.p.totals.income - x.p.totals.costs }));
    c.append(
      card(
        "Expenses against cash",
        "What came in, what was spent and what was left each month (transfers between your accounts left out).",
        legend([
          ["Cash in", "var(--g3)"],
          ["Expenses", "var(--g2)"],
          ["Left over", "var(--text)", true],
        ]),
        groupedBars(
          cash,
          [
            { key: "cashIn", label: "Cash in", colour: "var(--g3)" },
            { key: "expenses", label: "Expenses", colour: "var(--g2)" },
          ],
          { line: { key: "left", label: "Left over", colour: "var(--text)" } },
        ),
      ),
    );
  }

  if (level || needle) c.append(card("Transactions", `${rows.length} in this selection, newest first.`, txnList([...rows].sort((a, b) => b.date.localeCompare(a.date)))));
}

// ---------- Profit and loss ----------
/** Where the money went (the app's flow chart). Click a box for its ten largest transactions. */
function flowChart(pl, from, to) {
  const nodes = [];
  const links = [];
  const node = (name, group, col) => {
    let n = nodes.find((x) => x.name === name);
    if (!n) nodes.push((n = { name, group, col, value: 0, lines: [], inOff: 0, outOff: 0 }));
    return n;
  };
  const link = (a, b, value) => value > 0 && links.push({ a, b, value });
  const sum = (lines) => lines.reduce((a, l) => a + l.amount, 0);
  const hub = node("Income", "Income", 1);
  const income = pl.income.filter((l) => l.amount > 0);
  hub.lines = income;
  for (const l of income) {
    const n = node(l.category, "Income", 0);
    n.lines = [l];
    link(n, hub, l.amount);
  }
  const totalIn = sum(income);
  const buckets = new Map();
  for (const l of pl.costs.filter((x) => x.amount > 0)) buckets.set(l.bucket, [...(buckets.get(l.bucket) ?? []), l]);
  let totalOut = 0;
  for (const [bucket, lines] of [...buckets].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const total = sum(lines);
    totalOut += total;
    const b = node(`${bucket} costs`, bucket, 2);
    b.lines = lines;
    link(hub, b, total);
    const sorted = [...lines].sort((x, y) => y.amount - x.amount);
    for (const l of sorted.slice(0, 5)) {
      const cn = node(l.category, bucket, 3);
      cn.lines = [l];
      link(b, cn, l.amount);
    }
    const rest = sorted.slice(5);
    if (rest.length) {
      const o = node(`Other ${bucket.toLowerCase()}`, bucket, 3);
      o.lines = rest;
      link(b, o, sum(rest));
    }
  }
  const investing = sum(pl.investing.filter((l) => l.amount > 0));
  if (investing > 0) {
    const n = node("Investing", "Investment", 2);
    n.lines = pl.investing;
    link(hub, n, investing);
    totalOut += investing;
  }
  const debt = sum(pl.debt.filter((l) => l.amount > 0));
  if (debt > 0) {
    const n = node("Debt repayments", "Debt", 2);
    n.lines = pl.debt;
    link(hub, n, debt);
    totalOut += debt;
  }
  if (totalIn > totalOut) link(hub, node("Left over", "Surplus", 2), totalIn - totalOut);
  if (totalOut > totalIn) link(node("From savings or borrowing", "Shortfall", 0), hub, totalOut - totalIn);
  if (!links.length) return card("Where the money went", null, empty("No income or costs in this period."));
  for (const l of links) {
    l.a.out = (l.a.out ?? 0) + l.value;
    l.b.in = (l.b.in ?? 0) + l.value;
  }
  for (const n of nodes) n.value = Math.max(n.in ?? 0, n.out ?? 0);

  const W = 1000;
  const NW = 12;
  const GAP = 10;
  const SLOT = 30;
  const base = Math.max(totalIn, totalOut) || 1;
  const k = 560 / base;
  const cols = [0, 1, 2, 3].map((ci) => nodes.filter((n) => n.col === ci));
  const slotOf = (n) => Math.max(SLOT, Math.max(2, n.value * k));
  const H = Math.max(360, ...cols.map((col) => col.reduce((a, n) => a + slotOf(n), 0) + GAP * Math.max(0, col.length - 1)));
  const X = [200, 430, 650, 800];
  for (const [ci, col] of cols.entries()) {
    const total = col.reduce((a, n) => a + slotOf(n), 0) + GAP * Math.max(0, col.length - 1);
    let y = (H - total) / 2;
    for (const n of col) {
      n.x = X[ci];
      n.h = Math.max(2, n.value * k);
      n.y = y + (slotOf(n) - n.h) / 2;
      y += slotOf(n) + GAP;
    }
  }
  const fmtV = (v) => (PCT ? share(v, base) : audK(v));
  const svg = s("svg", { class: "chart flow", viewBox: `0 0 ${W} ${H + 10}`, role: "img", "aria-label": "Where the money went" });
  const drivers = h("div", { class: "drivers" });
  for (const l of links) {
    const h0 = l.value * k;
    const y0 = l.a.y + l.a.outOff;
    const y1 = l.b.y + l.b.inOff;
    l.a.outOff += h0;
    l.b.inOff += h0;
    const x0 = l.a.x + NW;
    const x1 = l.b.x;
    const xm = (x0 + x1) / 2;
    const colour = BUCKET_COLOUR[l.b.col >= 2 ? l.b.group : l.a.group] ?? "var(--g9)";
    svg.append(s("path", { d: `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}L${x1},${y1 + h0}C${xm},${y1 + h0} ${xm},${y0 + h0} ${x0},${y0 + h0}Z`, fill: colour, "fill-opacity": 0.22 }, s("title", {}, `${l.a.name} → ${l.b.name}: ${PCT ? share(l.value, base) : aud(l.value)}`)));
  }
  for (const n of nodes) {
    const gEl = s("g", { class: "node", tabindex: 0, role: "button", "aria-label": `${n.name}, ${PCT ? share(n.value, base) : aud(n.value)}. Show the largest transactions.` });
    gEl.append(s("rect", { x: n.x, y: n.y, width: NW, height: n.h, rx: 3, fill: BUCKET_COLOUR[n.group] ?? "var(--g9)" }));
    const left = n.col === 0;
    const tx = left ? n.x - 8 : n.x + NW + 8;
    const ty = n.y + n.h / 2;
    gEl.append(s("text", { x: tx, y: ty - 2, "text-anchor": left ? "end" : "start", class: "fl-name" }, n.name), s("text", { x: tx, y: ty + 12, "text-anchor": left ? "end" : "start", class: "fl-val" }, fmtV(n.value)));
    const pick = () => {
      const top = driversFor(n, from, to);
      drivers.replaceChildren(
        h("h3", {}, `Largest transactions: ${n.name} (${PCT ? share(n.value, base) : aud(n.value)})`),
        top.length
          ? table(null, top.map((t) => h("tr", {}, h("td", { class: "nowrap" }, date(t.date)), h("td", {}, t.description, h("span", { class: "sub" }, [t.category, t.detail].filter(Boolean).join(" · "))), h("td", { class: "r" }, money(Math.abs(t.amount))))))
          : empty(n.name === "Left over" ? "What was not spent, invested or used to repay debt." : "No individual transactions behind this box."),
      );
      drivers.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    gEl.addEventListener("click", pick);
    gEl.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
    svg.append(gEl);
  }
  return card("Where the money went", "Income on the left, through to what it paid for. Click a box for its ten largest transactions.", h("div", { class: "scroll" }, h("div", { class: "flow-wrap" }, svg)), drivers);
}

function pnl(c, d) {
  const st = UI.pnl;
  const period = d.pnl.periods.find((p) => p.key === st.period) ?? d.pnl.periods[0];
  const p = pnlOf(period.key, st);
  const set = (patch) => {
    Object.assign(UI.pnl, patch);
    redraw();
  };
  const select = h(
    "select",
    { "aria-label": "Period", onchange: (e) => set({ period: e.target.value }) },
    d.pnl.periods.map((x) => h("option", { value: x.key, selected: x.key === period.key ? "selected" : null }, x.label)),
  );
  c.append(
    h("div", { class: "controls" }, h("label", { class: "muted" }, "Period ", select), h("span", { class: "muted small" }, `${date(period.from)} to ${date(period.to)}`)),
    h(
      "div",
      { class: "controls" },
      seg(
        "Transfers between your accounts",
        [
          ["out", "Left out"],
          ["in", "Counted"],
        ],
        st.transfers ? "in" : "out",
        (v) => set({ transfers: v === "in" }),
      ),
      h("span", { class: "muted small" }, `${p.transfers.count} moves: `, money(p.transfers.out), " out, ", money(p.transfers.in), ` in${st.transfers ? ", included below" : ", not in the totals"}.`),
    ),
    h(
      "div",
      { class: "controls" },
      seg(
        "Refunds and returns",
        [
          ["net", "Netted against costs"],
          ["sep", "Shown as income"],
        ],
        st.refunds ? "sep" : "net",
        (v) => set({ refunds: v === "sep" }),
      ),
      h("span", { class: "muted small" }, `${p.refunds.count} refunds: `, money(p.refunds.total), ` back${st.refunds ? ", listed under Income" : ", taken off the costs they reverse"}.`),
    ),
    h(
      "div",
      { class: "controls" },
      seg(
        "Exceptional items",
        [
          ["in", "Included"],
          ["out", "Left out"],
        ],
        st.exceptional ? "out" : "in",
        (v) => set({ exceptional: v === "out" }),
      ),
    ),
    h(
      "div",
      { class: "tiles" },
      tile("Income", aud(p.totals.income)),
      tile("Costs", aud(p.totals.costs)),
      tile(p.totals.net >= 0 ? "Profit (income less costs)" : "Loss (costs above income)", aud(p.totals.net)),
      tile("Invested", aud(p.totals.investing), p.totals.debt ? `plus ${aud(p.totals.debt)} debt principal` : null),
    ),
  );

  // Month by month across a year or 12 months.
  if (!/^\d{4}-\d{2}$/.test(period.key)) {
    const months = d.pnl.periods.filter((x) => /^\d{4}-\d{2}$/.test(x.key) && x.key >= period.from.slice(0, 7) && x.key <= period.to.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key));
    const rows = months.map((m) => {
      const v = pnlOf(m.key, st);
      return { month: `${m.key}-01`, income: v.totals.income, costs: -v.totals.costs, net: v.totals.net };
    });
    if (rows.length)
      c.append(
        card(
          "Month by month",
          "Income above the line, costs below it; the line is each month's profit or loss. Choose a month in the period list for its detail.",
          legend([
            ["Income", "var(--g6)"],
            ["Costs", "var(--g2)"],
            ["Profit or loss", "var(--text)", true],
          ]),
          groupedBars(
            rows,
            [
              { key: "income", label: "Income", colour: "var(--g6)" },
              { key: "costs", label: "Costs", colour: "var(--g2)" },
            ],
            { line: { key: "net", label: "Profit or loss", colour: "var(--text)" } },
          ),
        ),
      );
  }

  c.append(flowChart(p, period.from, period.to));

  // The statement, each line opening to its merchants.
  const merchantsOf = (l, income) => {
    const by = new Map();
    for (const t of d.transactions) {
      if (!inRange(t, period.from, period.to) || (t.category ?? (income ? "Uncategorised income" : "Uncategorised")) !== l.category) continue;
      if (st.exceptional && t.exceptional) continue;
      const e = by.get(t.merchant) ?? { name: t.merchant, amount: 0, count: 0 };
      e.amount += income ? t.amount : -t.amount;
      e.count++;
      by.set(t.merchant, e);
    }
    return [...by.values()].sort((a, b) => b.amount - a.amount).slice(0, 12);
  };
  const section = (title, lines, income, note) => {
    const total = lines.reduce((a, l) => a + l.amount, 0);
    return card(
      title,
      note,
      lines.length
        ? h(
            "div",
            { class: "stmt" },
            lines.map((l) =>
              h(
                "details",
                {},
                h("summary", {}, h("span", {}, l.category, h("span", { class: "sub" }, l.bucket)), h("span", { class: "r muted pctcol" }, share(l.amount, total)), h("span", { class: "r" }, money(l.amount))),
                table(null, merchantsOf(l, income).map((m) => h("tr", {}, h("td", {}, m.name, h("span", { class: "sub" }, `${m.count} transaction${m.count === 1 ? "" : "s"}`)), h("td", { class: "r" }, money(m.amount))))),
              ),
            ),
            h("div", { class: "stmt-total" }, h("strong", {}, "Total"), h("strong", { class: "num" }, aud(total))),
          )
        : empty("None in this period."),
    );
  };
  c.append(
    h("div", { class: "grid2" }, section("Income", p.income, true), section("Costs", p.costs, false)),
    h(
      "div",
      { class: "grid2" },
      section("Investing", p.investing, false, "Money moved into shares or super. Not a cost: it is still yours."),
      section("Debt principal", p.debt, false, "Principal repaid on loans other than the mortgage. Interest is a cost above."),
    ),
  );

  const refunds = d.pnl.refunds.filter((r) => inRange(r, period.from, period.to));
  c.append(
    card(
      "Refunds",
      "Money back in the period, each with the purchase it most likely reverses.",
      refunds.length
        ? table(
            ["Date", "Refund", "Category", "Original purchase", "Back"],
            refunds.map((r) =>
              h(
                "tr",
                {},
                h("td", { class: "nowrap" }, date(r.date)),
                h("td", {}, r.description, r.detail ? h("span", { class: "sub" }, r.detail) : null),
                h("td", {}, r.category),
                h("td", {}, r.original ? [r.original.description, h("span", { class: "sub" }, `${date(r.original.date)} · ${aud(r.original.amount)}`)] : h("span", { class: "muted" }, "Not found")),
                h("td", { class: "r pos" }, money(r.amount)),
              ),
            ),
            4,
          )
        : empty("No refunds in this period."),
    ),
  );
}

// ---------- Transactions ----------
function transactions(c, d) {
  const st = UI.transactions;
  const accounts = [...new Set(d.transactions.map((t) => t.account))].sort();
  const cats = [...new Set(d.transactions.map((t) => t.category).filter(Boolean))].sort();
  const views = [
    ["all", "All"],
    ["review", `Needs a category (${d.transactions.filter((t) => t.review || (!t.category && !t.transfer)).length})`],
    ["spending", "Spending only"],
    ["excluded", "Excluded flows"],
  ];
  const needle = st.q.trim().toLowerCase();
  let rows = d.transactions.filter(
    (t) =>
      (st.view !== "review" || t.review || (!t.category && !t.transfer)) &&
      (st.view !== "spending" || (isSpending(t) && t.amount < 0)) &&
      (st.view !== "excluded" || t.transfer || ["transfer", "loan_repayment", "investment"].includes(t.kind) || ["Transfer", "Investment", "Debt"].includes(t.bucket)) &&
      (!st.account || t.account === st.account) &&
      (!st.category || (st.category === "-" ? !t.category && !t.transfer : t.category === st.category)) &&
      (!st.from || t.date >= st.from) &&
      (!st.to || t.date <= st.to) &&
      (!needle || `${t.description} ${t.merchant} ${t.detail ?? ""} ${t.category ?? ""}`.toLowerCase().includes(needle)),
  );
  if (st.sort === "amount") rows = [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  if (st.sort === "amount-asc") rows = [...rows].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  if (st.sort === "date-asc") rows = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const set = (patch) => {
    Object.assign(UI.transactions, patch);
    redraw();
  };
  const q = h("input", { type: "search", value: st.q, placeholder: "Search descriptions and details", "aria-label": "Search" });
  q.addEventListener("change", () => set({ q: q.value }));
  const sel = (label, value, opts, key) => h("select", { "aria-label": label, onchange: (e) => set({ [key]: e.target.value }) }, opts.map(([v, t]) => h("option", { value: v, selected: v === value ? "selected" : null }, t)));
  const dateIn = (label, key) => h("label", { class: "muted small" }, `${label} `, h("input", { type: "date", value: st[key], "aria-label": label, onchange: (e) => set({ [key]: e.target.value }) }));
  const inflow = rows.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const out = rows.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
  c.append(
    pills(views, st.view, (v) => set({ view: v }), "Views"),
    card(
      "Transactions",
      "Every confirmed transaction, one row per account. Card, account and reference numbers are removed from the text.",
      h(
        "div",
        { class: "filters" },
        q,
        sel("Account", st.account, [["", "All accounts"], ...accounts.map((a) => [a, a])], "account"),
        sel("Category", st.category, [["", "All categories"], ["-", "Needs a category"], ...cats.map((x) => [x, x])], "category"),
        dateIn("From", "from"),
        dateIn("To", "to"),
        sel(
          "Sort",
          st.sort,
          [
            ["date", "Newest first"],
            ["date-asc", "Oldest first"],
            ["amount", "Largest first"],
            ["amount-asc", "Smallest first"],
          ],
          "sort",
        ),
      ),
      h("p", { class: "muted" }, `${rows.length.toLocaleString("en-AU")} transactions · in `, money(inflow), " · out ", money(out)),
      txnList(rows),
    ),
  );
}

// ---------- Exceptional items ----------
function exceptional(c, d) {
  const e = d.exceptional;
  const marked = e.items.filter((i) => i.marked);
  const suggested = e.items.filter((i) => !i.marked);
  const row = (i) =>
    h(
      "tr",
      {},
      h("td", { class: "nowrap" }, date(i.date)),
      h("td", {}, i.description, i.marked ? h("span", { class: "badge" }, "Marked") : null, i.strength ? h("span", { class: `badge ${i.strength === "strong" ? "warn" : ""}` }, i.strength === "strong" ? "Strong" : "Possible") : null, i.reason ? h("span", { class: "sub" }, i.reason) : null),
      h("td", {}, i.category),
      h("td", { class: `r nowrap ${i.kind === "income" ? "pos" : ""}` }, money(i.kind === "income" ? i.amount : -i.amount)),
    );
  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Marked exceptional", String(marked.length), `${suggested.length} more suggested`),
      tile("Costs, everything", aud(e.withAll.costs)),
      tile("Costs without exceptional", aud(e.without.costs), e.withAll.costs ? `${(((e.withAll.costs - e.without.costs) / e.withAll.costs) * 100).toFixed(1)}% less` : null),
      tile("Profit without exceptional", aud(e.without.net), `against ${aud(e.withAll.net)} with them`),
    ),
    card("Marked", `One-offs you can leave out on the Spending and Profit and loss pages (${date(e.from)} to ${date(e.to)}).`, marked.length ? table(["Date", "Transaction", "Category", "Amount"], marked.map(row), 3) : empty("None marked.")),
    card("Suggested", "Large or unusual against your own pattern; not marked yet.", table(["Date", "Transaction", "Category", "Amount"], suggested.map(row), 3)),
  );
}

// ---------- Asset tracker ----------
const SLOTS = ["var(--g1)", "var(--g2)", "var(--g3)", "var(--g7)", "var(--g4)", "var(--g8)"];
function tracker(c, d) {
  const st = UI.tracker;
  const L = window.FinLib;
  const growth = st.growth ?? d.trackerDefaults.growthPct;
  const discount = st.discount ?? d.trackerDefaults.askingDiscountPct;
  const set = (patch) => {
    Object.assign(UI.tracker, patch);
    redraw();
  };
  const sh = d.shares;
  const props = d.property.map((p) => ({ ...p, v: L.valueProperty(p.comps, p.subject ?? {}, { growthPct: growth, today: d.asOf, recorded: p.recorded }), implied: L.impliedGrowth(p.comps, p.subject ?? {}) }));
  const cars = d.vehicles.map((v) => ({ ...v, val: L.valueVehicle(v.comps, { km: v.km }, { askingDiscountPct: discount, recorded: v.recorded }) }));
  const superLast = d.super.reduce((a, f) => a + (f.points[f.points.length - 1]?.balance ?? 0), 0);
  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Shares and ETFs", aud(sh.total), sh.platforms.map((p) => `${p.name} ${aud(p.value)}`).join(" · ")),
      props.map((p) => tile(p.name, p.v ? aud(p.v.estimate) : aud(p.recorded || 0), p.v ? `from ${p.v.used} like-for-like sales; you record ${aud(p.recorded || 0)}` : null)),
      cars.map((v) => tile(v.name, v.val ? aud(v.val.estimate) : aud(v.recorded || 0), v.val ? `from ${v.val.used} listings; you record ${aud(v.recorded || 0)}` : null)),
      d.super.length ? tile("Super", aud(superLast), d.super[0].cagr != null ? `${pct(d.super[0].cagr)} a year since ${date(d.super[0].points[0].date)}` : null) : null,
    ),
  );

  // Price history, indexed to 100.
  const tickers = sh.holdings.map((x) => x.ticker);
  const colour = new Map([...tickers].sort().map((t, i) => [t, SLOTS[i % SLOTS.length]]));
  const rows = sh.chart[st.period] ?? [];
  const shown = tickers.filter((t) => rows[0] && typeof rows[0][t] === "number");
  c.append(
    cardWith(
      "Price history, indexed to 100",
      "Each line starts at 100 at the beginning of the period: 120 means up 20%. Price only; distributions are not added back.",
      pills(
        [
          ["1Y", "1Y"],
          ["3Y", "3Y"],
          ["5Y", "5Y"],
        ],
        st.period,
        (v) => set({ period: v }),
        "Period",
      ),
      legend(shown.map((t) => [t, colour.get(t), true])),
      rows.length && shown.length
        ? lineChart(
            shown.map((t) => ({ label: t, colour: colour.get(t), points: rows.map((r) => ({ x: r.date, y: typeof r[t] === "number" ? r[t] : null })) })),
            { fmt: (v) => v.toFixed(0), title: date, height: 260 },
          )
        : empty("No price history."),
      tickers.length > shown.length ? h("p", { class: "muted small" }, `Not enough history for ${st.period}: ${tickers.filter((t) => !shown.includes(t)).join(", ")}.`) : null,
    ),
    card(
      "Each holding",
      "Returns are price changes over each period (3 and 5 years as a yearly rate). Volatility is how much the price swings in a year. Max fall is the deepest drop from a high in five years.",
      table(
        ["Holding", "Value", "Gain", "1M", "3M", "1Y", "3Y a yr", "5Y a yr", "Volatility", "Max fall", "52-week range"],
        sh.holdings.map((x) => {
          const span = x.high52 && x.low52 && x.high52 > x.low52 && x.price ? (x.price - x.low52) / (x.high52 - x.low52) : null;
          return h(
            "tr",
            {},
            h("td", {}, h("strong", {}, x.ticker), x.geared ? h("span", { class: "badge warn" }, "Geared") : null, h("span", { class: "sub" }, x.name), h("span", { class: "sub" }, `${x.platform} · ${x.units.toLocaleString("en-AU", { maximumFractionDigits: 2 })} units`)),
            h("td", { class: "r" }, money(x.value || 0), x.price ? h("span", { class: "sub" }, `at ${aud(x.price, 2)}`) : null),
            h("td", { class: `r ${tone(x.gain)}` }, x.gain == null ? h("span", { class: "muted" }, "cost not known") : [money(x.gain), x.cost ? h("span", { class: "sub" }, pct(x.gain / x.cost)) : null]),
            ["1M", "3M", "1Y", "3Y", "5Y"].map((k) => h("td", { class: `r num ${tone(x.returns[k])}` }, pct(x.returns[k]))),
            h("td", { class: "r num" }, x.volatility == null ? "–" : `${(x.volatility * 100).toFixed(0)}%`),
            h("td", { class: "r num neg" }, pct(x.maxFall), x.maxFallDate ? h("span", { class: "sub" }, date(x.maxFallDate)) : null),
            h("td", { class: "r" }, span == null ? "–" : h("div", { class: "range52" }, h("div", { class: "rtrack" }, h("span", { style: { left: `calc(${(span * 100).toFixed(0)}% - 2px)` } })), h("span", { class: "sub" }, x.offHigh > -0.001 ? "at its high" : `${pct(x.offHigh)} off high`))),
          );
        }),
        1,
      ),
      sh.holdings.some((x) => x.geared) ? h("p", { class: "muted small" }, "Geared funds borrow inside the fund to hold more shares than your money buys: rises and falls are roughly 1.3 to 1.6 times the market's.") : null,
    ),
  );

  // Property and car against comparables: the assumptions recalculate here, with the app's code.
  const assumption = (label, value, key) => {
    const input = h("input", { type: "number", step: "0.1", value: String(value), "aria-label": label, class: "small-input" });
    return h("form", { class: "assume", onsubmit: (e) => (e.preventDefault(), set({ [key]: Number(input.value) })) }, h("label", { class: "muted small" }, label, " ", input), h("button", { type: "submit", class: "ghost" }, "Apply"));
  };
  const estimateLine = (v) =>
    h(
      "p",
      {},
      h("span", { class: "muted small" }, "Estimate "),
      h("strong", { class: "num big" }, aud(v.estimate)),
      h("span", { class: "muted small" }, "  likely "),
      h("span", { class: "num" }, `${aud(v.low)} to ${aud(v.high)}`),
      v.likelihood != null
        ? [
            h("span", { class: "muted small" }, `  chance it is worth at least your ${aud(v.recorded)}: `),
            h("strong", {}, `${(v.likelihood * 100).toFixed(0)}%`),
            h("span", { class: `badge ${v.likelihood >= 0.7 ? "" : "warn"}` }, v.likelihood >= 0.7 ? "likely holds" : v.likelihood >= 0.4 ? "about even" : "probably optimistic"),
          ]
        : null,
    );
  for (const p of props) {
    const v = p.v;
    c.append(
      cardWith(
        `${p.name}: like-for-like sales`,
        `Each sale is brought to today at ${growth}% a year and scaled to your floor area, using sales with your bedroom count. Sales in your building count double; recent sales count more. Listings and price guides are shown but not used. Changes here are not saved.`,
        assumption("Price growth a year (%)", growth, "growth"),
        p.subject ? h("p", { class: "muted small" }, `Yours: ${p.subject.bedrooms ?? "?"} bedroom${p.subject.bedrooms === 1 ? "" : "s"}, ${p.subject.bathrooms ?? "?"} bathroom, ${p.subject.parking ?? "?"} car space, ${p.subject.areaSqm ?? "?"} m².`) : null,
        p.implied
          ? h(
              "p",
              { class: "small" },
              `Your ${p.implied.sales} like-for-like sales (${date(p.implied.from)} to ${date(p.implied.to)}) imply `,
              h("strong", { class: tone(p.implied.ratePct) }, `${p.implied.ratePct >= 0 ? "+" : ""}${p.implied.ratePct}% a year`),
              Math.abs(p.implied.ratePct - growth) >= 0.5 ? [` against the ${growth}% used here. `, h("button", { type: "button", class: "link", onclick: () => set({ growth: p.implied.ratePct }) }, `Use ${p.implied.ratePct}%`)] : ", close to the rate used here.",
            )
          : null,
        v
          ? h(
              "div",
              {},
              estimateLine(v),
              valueBand(v),
              table(
                ["Date", "Sale", "Beds · m²", "Price", "Today, like for like", "How"],
                v.adjusted.map((x) =>
                  h(
                    "tr",
                    { class: x.used ? "" : "dim" },
                    h("td", { class: "nowrap" }, date(x.date)),
                    h("td", {}, x.label, h("span", { class: "badge" }, x.kind === "sold" ? "Sold" : x.kind === "listing" ? "Listed" : "Guide"), x.sameBuilding ? h("span", { class: "badge" }, "Same building") : null),
                    h("td", { class: "nowrap" }, `${x.bedrooms ?? "?"} bed${x.areaSqm ? ` · ${x.areaSqm} m²` : ""}`),
                    h("td", { class: "r" }, money(x.price)),
                    h("td", { class: "r" }, x.used ? money(x.adjusted) : "–"),
                    h("td", { class: "muted small" }, x.why),
                  ),
                ),
                3,
              ),
            )
          : empty("No comparable sales."),
      ),
    );
  }
  for (const car of cars) {
    const v = car.val;
    c.append(
      cardWith(
        `${car.name}: listings`,
        `A straight line of asking price against kilometres across the listings, read at your kilometres, less ${discount}% because listings are asking prices.${v?.slopePer10k ? ` Each extra 10,000 km is worth about ${aud(Math.abs(v.slopePer10k))}.` : ""} Changes here are not saved.`,
        assumption("Below asking price (%)", discount, "discount"),
        h("p", { class: "muted small" }, car.km ? `Odometer: ${car.km.toLocaleString("en-AU")} km.` : "No odometer reading: read at the listings' average kilometres."),
        v
          ? h(
              "div",
              {},
              estimateLine(v),
              valueBand(v),
              table(
                ["Date", "Listing", "Kilometres", "Price", "Today, like for like", "How"],
                v.adjusted.map((x) => h("tr", {}, h("td", { class: "nowrap" }, date(x.date)), h("td", {}, x.label), h("td", { class: "r num" }, x.km?.toLocaleString("en-AU") ?? "–"), h("td", { class: "r" }, money(x.price)), h("td", { class: "r" }, money(x.adjusted)), h("td", { class: "muted small" }, x.why))),
                2,
              ),
            )
          : empty("Not enough listings."),
      ),
    );
  }
  for (const f of d.super) {
    const pts = f.points;
    c.append(
      card(
        f.name,
        "Balances from your statements and screenshots. Growth includes contributions, so it is higher than the fund's investment return.",
        h("p", {}, money(pts[0].balance), ` on ${date(pts[0].date)} to `, money(pts[pts.length - 1].balance), ` on ${date(pts[pts.length - 1].date)}`, f.cagr != null ? h("span", { class: tone(f.cagr) }, `, ${pct(f.cagr)} a year`) : null),
        table(
          ["Period", "Change", "Growth"],
          pts.slice(1).map((p, i) => h("tr", {}, h("td", {}, `${date(pts[i].date)} to ${date(p.date)}`), h("td", { class: "r" }, money(p.balance - pts[i].balance)), h("td", { class: `r ${tone(p.balance - pts[i].balance)}` }, pct(pts[i].balance ? p.balance / pts[i].balance - 1 : null)))),
          1,
        ),
      ),
    );
  }
}

// ---------- Forecast (the app's engine, in this browser) ----------
const FIELDS = [
  ["age", "Your age today", 1],
  ["retireAge", "Work until age", 1],
  ["monthlySavings", "Monthly savings ($)", 100],
  ["livingCosts", "Living costs a year, excl. mortgage ($)", 1000],
  ["netRent", "Net rent a year ($)", 1000],
  ["inflationPct", "Cost inflation (%)", 0.1],
  ["salaryGrowthPct", "Pay and savings growth (%)", 0.1],
  ["propertyGrowthPct", "Property growth (%)", 0.1],
  ["sharesReturnPct", "Shares return (%)", 0.1],
  ["superReturnPct", "Super return after fees (%)", 0.1],
  ["cashRatePct", "Cash interest (%)", 0.1],
  ["vehicleChangePct", "Car value change a year (%)", 0.5],
  ["loanRatePct", "Mortgage rate (%)", 0.01],
  ["loanRepaymentMonthly", "Mortgage repayment a month ($)", 50],
  ["withdrawalRatePct", "Safe withdrawal rate (%)", 0.1],
];
const SC_COLOUR = { invest: "var(--g7)", loan: "var(--g1)", split: "var(--g3)", cash: "var(--g4)" };
function forecast(c, d) {
  const L = window.FinLib;
  const st = UI.forecast;
  const f = d.forecast;
  const a = st.a ?? { ...f.defaults };
  const inputs = L.toInputs(f.start, a);
  const results = L.SCENARIOS.map((sc) => L.runScenario(inputs, sc, a.retireAge));
  const v = (cents, age) => (st.today ? L.real(cents, age - a.age, a.inflationPct) : cents);
  const unit = st.today ? "today's dollars" : "future dollars";
  const set = (patch) => {
    Object.assign(UI.forecast, patch);
    redraw();
  };
  const form = h(
    "form",
    { class: "assumptions", onsubmit: (e) => e.preventDefault() },
    FIELDS.map(([key, label, step]) => {
      const input = h("input", { type: "number", step: String(step), value: String(a[key]), "aria-label": label });
      input.addEventListener("change", () => {
        const n = Number(input.value);
        if (isFinite(n)) set({ a: { ...a, [key]: n } });
      });
      return h("label", {}, h("span", { class: "muted small" }, label), input);
    }),
    h("button", { type: "button", class: "ghost", onclick: () => set({ a: null }) }, "Back to the app's assumptions"),
  );
  c.append(
    h(
      "div",
      { class: "controls" },
      seg(
        "Show",
        [
          ["today", "Today's dollars"],
          ["future", "Future dollars"],
        ],
        st.today ? "today" : "future",
        (x) => set({ today: x === "today" }),
      ),
      h("span", { class: "muted small" }, "A planning sketch, not advice. Assumption changes here are not saved."),
    ),
    h(
      "div",
      { class: "tiles" },
      results.map((r) => {
        const at = r.atRetirement;
        return tile(
          `${r.scenario.label}${r.scenario.key === f.plan ? " (your plan)" : ""}`,
          aud(v(at.netWorth, at.age)),
          `net worth at ${a.retireAge}, ${unit} · could stop work ${r.earlyRetirementAge === null ? `not before ${a.retireAge}` : `about ${Math.floor(r.earlyRetirementAge)}`} · mortgage-free ${r.mortgageFreeAge === null ? `after ${a.retireAge}` : `about ${Math.floor(r.mortgageFreeAge)}`}`,
        );
      }),
    ),
    card(
      "Net worth by age",
      `Each scenario puts your ${aud(a.monthlySavings * 100)} a month somewhere different; ${unit}.`,
      legend(results.map((r) => [r.scenario.label, SC_COLOUR[r.scenario.key] ?? "var(--g9)", true])),
      lineChart(
        results.map((r) => ({ label: r.scenario.label, colour: SC_COLOUR[r.scenario.key] ?? "var(--g9)", points: r.years.map((y) => ({ x: y.age, y: v(y.netWorth, y.age) })) })),
        { xFmt: (x) => `${Math.round(x)}`, title: (x) => `Age ${Math.round(x)}`, height: 280 },
      ),
    ),
    card(
      `Assets against debts at ${a.retireAge}`,
      `What each scenario holds when you stop work, ${unit}.`,
      table(
        ["", ...results.map((r) => r.scenario.label)],
        [
          ["Property", (y) => y.property],
          ["Shares", (y) => y.shares],
          ["Cash", (y) => y.cash],
          ["Super", (y) => y.super],
          ["Car", (y) => y.vehicle],
          ["Mortgage", (y) => -y.loan],
          ["HELP", (y) => -y.help],
          ["Net worth", (y) => y.netWorth],
          ["Accessible (not super or property)", (y) => y.accessible],
        ].map(([label, fn]) => h("tr", {}, h("td", {}, label), results.map((r) => h("td", { class: "r" }, money(v(fn(r.atRetirement), r.atRetirement.age)))))),
        1,
      ),
    ),
    card("Assumptions", "Change any of these to see the effect; nothing is saved.", form),
  );
}

// ---------- Tax return ----------
function tax(c, d) {
  const TREAT = { income: "Income", claim: "Claim", confirm: "Confirm first", spread: "Spread", depreciate: "Depreciate", capital: "Capital", private: "Private", credit: "Tax credit", check: "Cross-check", gain: "Gain", "gain (discount)": "Gain (50% discount)", loss: "Loss" };
  const res = (x) => (x.result > 0 ? `${aud(x.result, 2)} to pay` : `${aud(-x.result, 2)} refund`);
  const i = UI.tax.fy == null ? Math.max(0, d.tax.length - 2) : UI.tax.fy;
  const t = d.tax[i];
  const e = t.estimate;
  const chosen = e.cases.find((x) => x.pct === e.chosenPct) ?? e.cases[1];
  const rowsSpec = [
    ["Net rent", (x) => x.rentalNet],
    ["Taxable income", (x) => x.taxable],
    ["Income tax", (x) => x.incomeTax],
    ["Medicare levy", (x) => x.medicare],
    ["HELP repayment", (x) => x.help],
    ["Tax withheld", (x) => -x.payg],
    ["Credits", (x) => -x.credits],
  ];
  c.append(
    pills(
      d.tax.map((x, j) => [j, x.fy]),
      i,
      (j) => ((UI.tax.fy = j), redraw()),
      "Financial year",
    ),
    h(
      "div",
      { class: "tiles" },
      tile("Estimate", res(chosen), `${chosen.pct}% of loan interest deductible${e.chosenPct ? " (your position)" : ""}`),
      tile("Taxable income", aud(chosen.taxable)),
      tile("Salary", aud(e.salary), e.salaryBasis),
      tile("Tax withheld", aud(e.payg)),
    ),
    card(
      "Estimate by how much loan interest is deductible",
      "An estimate to plan with, not your assessment.",
      table(
        ["", ...e.cases.map((x) => `${x.pct}%${x.pct === e.chosenPct ? " (yours)" : ""}`)],
        [...rowsSpec.map(([label, fn]) => h("tr", {}, h("td", {}, label), e.cases.map((x) => h("td", { class: "r" }, money(fn(x)))))), h("tr", {}, h("td", {}, h("strong", {}, "Result")), e.cases.map((x) => h("td", { class: `r ${x.result > 0 ? "neg" : "pos"}` }, h("strong", {}, res(x)))))],
        1,
      ),
    ),
    t.buckets
      .filter((b) => b.lines.length)
      .map((b) =>
        card(
          b.title,
          b.note,
          table(
            null,
            b.lines.map((l) =>
              h(
                "tr",
                {},
                h("td", {}, l.label, l.taxLabel ? h("span", { class: "badge" }, l.taxLabel) : null, l.date ? h("span", { class: "sub" }, date(l.date)) : null),
                h("td", { class: "muted nowrap" }, TREAT[l.treatment] ?? l.treatment, l.workUsePct != null && l.workUsePct !== 100 ? ` · ${l.workUsePct}% work` : ""),
                h("td", { class: "r" }, money(l.amount)),
              ),
            ),
          ),
        ),
      ),
  );
}

// ---------- Bills ----------
function bills(c, d) {
  c.append(card("Upcoming bills", "Expected from your history.", d.bills.length ? table(null, d.bills.map((b) => h("tr", {}, h("td", {}, b.name, h("span", { class: "sub" }, `${date(b.expected)} · ${b.cadence}`)), h("td", { class: "r" }, money(Math.abs(b.amount)))))) : empty("None expected.")));
}

const PAGES = { overview, networth, spending, pnl, transactions, exceptional, tracker, forecast, tax, bills };

// ---------- page shell ----------
function setPct(on) {
  PCT = on;
  document.body.classList.toggle("pct", on);
  $("amounts")
    .querySelectorAll("button")
    .forEach((b) => {
      const active = (b.dataset.mode === "pct") === on;
      b.classList.toggle("on", active);
      b.setAttribute("aria-pressed", String(active));
    });
  if (DATA) redraw();
}
$("amounts")
  .querySelectorAll("button")
  .forEach((b) => b.addEventListener("click", () => setPct(b.dataset.mode === "pct")));

function render(d) {
  DATA = d;
  $("asof").textContent = `As at ${date(d.asOf)}`;
  $("foot").textContent = `Read-only copy made ${new Date(d.generatedAt).toLocaleString("en-AU")}. Nothing here can be changed, uploaded or downloaded; account, card and reference numbers are removed.`;
  route();
}
window.addEventListener("hashchange", () => route());

let sealed = null;
async function load() {
  if (sealed) return sealed;
  const res = await fetch("data.json", { cache: "no-store" });
  if (!res.ok) throw new Error("The data file is missing.");
  sealed = await res.json();
  return sealed;
}

$("unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("open");
  const pw = $("pw");
  $("err").textContent = "";
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const data = await open(await load(), pw.value);
    pw.value = "";
    if (data.version !== 2) throw new Error("This copy is from an older version; rebuild it.");
    render(data);
    $("lock").hidden = true;
    $("app").hidden = false;
  } catch (err) {
    $("err").textContent = err && err.name === "OperationError" ? "That password does not open it." : `Could not open: ${err.message || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Open";
  }
});

$("lockbtn").addEventListener("click", () => {
  // Forget the decrypted figures and every choice, not just hide them.
  DATA = null;
  UI.forecast.a = null;
  $("content").replaceChildren();
  $("tabs").replaceChildren();
  $("app").hidden = true;
  $("lock").hidden = false;
  $("pw").focus();
});
