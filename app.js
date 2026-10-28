/*
 * Read-only viewer. Fetches data.json (ciphertext), derives the key from the password with PBKDF2-SHA256 and
 * decrypts with AES-256-GCM in this browser (the same steps as src/lib/pages-crypto.ts), then draws the summary.
 * Nothing is stored: closing or locking the page forgets the data and the password.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GROUPS = ["Property and home", "Food and drink", "Transport", "Shopping", "Health and wellbeing", "Lifestyle and entertainment", "Travel", "Bills, fees and work", "Other"];
const groupColour = (g) => `var(--g${Math.min(GROUPS.indexOf(g) + 1 || 9, 9)})`;

// ---------- formatting ----------
const aud = (cents, digits = 0) =>
  (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const audK = (cents) => {
  const v = Math.abs(cents) / 100;
  const s = v >= 1e6 ? `$${(v / 1e6).toFixed(2)}m` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k` : `$${v.toFixed(0)}`;
  return cents < 0 ? `-${s}` : s;
};
const pct = (v, d = 1) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const tone = (v) => (v == null ? "muted" : v >= 0 ? "pos" : "neg");
const date = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const monthLabel = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

// ---------- DOM helpers (textContent only; styles through the CSSOM, which the page's policy allows) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
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
const tile = (label, value, note) => h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value num" }, value), note ? h("div", { class: "note" }, note) : null);
const legend = (items) => h("div", { class: "legend" }, items.map(([label, colour, line]) => h("span", {}, h("i", { class: line ? "line" : "", style: { background: colour } }), label)));

// ---------- decrypt ----------
const unb64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
async function open(sealed, password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unb64(sealed.salt), iterations: sealed.iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- charts (one axis each; hover shows the figure) ----------
function lineChart(series, { height = 240, fmt = audK } = {}) {
  const W = 760;
  const H = height;
  const pad = { l: 58, r: 12, t: 10, b: 24 };
  const xs = series[0].points.map((p) => p.x);
  const all = series.flatMap((sr) => sr.points.map((p) => p.y));
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const X = (i) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, xs.length - 1);
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": series.map((x) => x.label).join(", ") });
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }), s("text", { x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
  const step = Math.ceil(xs.length / 8);
  xs.forEach((x, i) => {
    // The last label sits flush right so it is not cut off at the edge.
    if (i % step === 0 || i === xs.length - 1) svg.append(s("text", { x: X(i), y: H - 6, "text-anchor": i === xs.length - 1 ? "end" : "middle" }, monthLabel(x)));
  });
  for (const sr of series) {
    const d = sr.points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    svg.append(s("path", { d, fill: "none", stroke: sr.colour, "stroke-width": 2, "stroke-dasharray": sr.dashed ? "5 4" : null }));
  }
  // Hover targets: one column per point, its title listing every series.
  xs.forEach((x, i) => {
    const w = (W - pad.l - pad.r) / Math.max(1, xs.length - 1);
    svg.append(
      s("rect", { x: X(i) - w / 2, y: pad.t, width: w, height: H - pad.t - pad.b, fill: "transparent" }, s("title", {}, `${date(x)}\n${series.map((sr) => `${sr.label}: ${aud(sr.points[i].y)}`).join("\n")}`)),
    );
  });
  return svg;
}

function stackedBars(rows, keys, colourOf, { height = 240 } = {}) {
  const W = 760;
  const H = height;
  const pad = { l: 58, r: 8, t: 10, b: 24 };
  const totals = rows.map((r) => keys.reduce((a, k) => a + Math.max(0, r[k] || 0), 0));
  const hi = Math.max(1, ...totals);
  const bw = (W - pad.l - pad.r) / rows.length;
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / hi;
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Spending by month" });
  for (let k = 0; k <= 4; k++) {
    const v = (hi * k) / 4;
    svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }), s("text", { x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, audK(v)));
  }
  rows.forEach((r, i) => {
    let base = 0;
    const x = pad.l + i * bw + bw * 0.18;
    for (const k of keys) {
      const v = Math.max(0, r[k] || 0);
      if (!v) continue;
      const y1 = Y(base + v);
      const y0 = Y(base);
      // A 2px surface gap between stacked segments.
      svg.append(s("rect", { x, y: y1, width: bw * 0.64, height: Math.max(0, y0 - y1 - 2), rx: 2, fill: colourOf(k) }, s("title", {}, `${monthLabel(r.month)} · ${k}: ${aud(v)}`)));
      base += v;
    }
    svg.append(s("text", { x: x + bw * 0.32, y: H - 6, "text-anchor": "middle" }, monthLabel(r.month)));
  });
  return svg;
}

function groupedBars(rows, series, { height = 220 } = {}) {
  const W = 760;
  const H = height;
  const pad = { l: 58, r: 8, t: 10, b: 24 };
  const hi = Math.max(1, ...rows.flatMap((r) => series.map((sr) => r[sr.key])));
  const bw = (W - pad.l - pad.r) / rows.length;
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / hi;
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": series.map((x) => x.label).join(" against ") });
  for (let k = 0; k <= 4; k++) {
    const v = (hi * k) / 4;
    svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }), s("text", { x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, audK(v)));
  }
  const each = (bw * 0.7) / series.length;
  rows.forEach((r, i) => {
    series.forEach((sr, j) => {
      const v = Math.max(0, r[sr.key]);
      const x = pad.l + i * bw + bw * 0.15 + j * each;
      svg.append(s("rect", { x, y: Y(v), width: each - 2, height: Math.max(0, Y(0) - Y(v)), rx: 2, fill: sr.colour }, s("title", {}, `${monthLabel(r.month)} · ${sr.label}: ${aud(v)}`)));
    });
    svg.append(s("text", { x: pad.l + i * bw + bw / 2, y: H - 6, "text-anchor": "middle" }, monthLabel(r.month)));
  });
  return svg;
}

/** Estimate, likely range and the recorded value on one line. */
function valueBand(v) {
  const pts = [v.low, v.high, v.estimate, v.recorded ?? v.estimate];
  const lo = Math.min(...pts) * 0.97;
  const hi = Math.max(...pts) * 1.03;
  const at = (x) => `${(((x - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  return h(
    "div",
    { class: "band", role: "img", "aria-label": `Estimate ${aud(v.estimate)}, likely ${aud(v.low)} to ${aud(v.high)}` },
    h("span", { class: "shade", style: { left: at(v.low), right: `calc(100% - ${at(v.high)})` } }),
    h("span", { class: "tick", style: { left: at(v.estimate) } }),
    v.recorded != null ? h("span", { class: "mine", style: { left: at(v.recorded) } }) : null,
  );
}

// ---------- tabs ----------
const TABS = [
  ["overview", "Overview"],
  ["assets", "Shares and assets"],
  ["pnl", "Profit and loss"],
  ["spending", "Spending"],
  ["transactions", "Transactions"],
  ["exceptional", "Exceptional items"],
  ["tax", "Tax return"],
  ["forecast", "Forecast"],
  ["bills", "Bills"],
];
let DATA = null;

function nav(active) {
  $("tabs").replaceChildren(
    ...TABS.map(([id, label]) => h("a", { href: `#${id}`, class: id === active ? "on" : "", "aria-current": id === active ? "page" : null }, label)),
  );
}

function route() {
  if (!DATA) return;
  const id = (location.hash || "#overview").slice(1);
  const tab = TABS.some(([t]) => t === id) ? id : "overview";
  nav(tab);
  const c = $("content");
  c.replaceChildren();
  ({ overview, assets, pnl, spending, transactions, exceptional, tax, forecast, bills })[tab](c, DATA);
  window.scrollTo(0, 0);
}

function overview(c, d) {
  const nw = d.netWorth;
  const assetsTotal = Object.values(nw.assets).reduce((a, b) => a + b, 0);
  const debts = Object.values(nw.liabilities).reduce((a, b) => a + b, 0);
  const first = nw.history[0];
  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Net worth", aud(nw.current), first ? `${aud(nw.current - first.netWorth)} since ${date(first.date)}` : null),
      tile("Accessible wealth", aud(nw.accessible), "Cash, offset and shares"),
      tile("Assets", aud(assetsTotal)),
      tile("Debts", aud(debts)),
    ),
    card(
      "Net worth over time",
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
  );
  const classRows = [...Object.entries(nw.assets).map(([k, v]) => [k, v, false]), ...Object.entries(nw.liabilities).map(([k, v]) => [k, v, true])].filter(([, v]) => v);
  c.append(
    h(
      "div",
      { class: "grid2" },
      card("Today, by class", null, h("table", {}, h("tbody", {}, classRows.map(([k, v, debt]) => h("tr", {}, h("td", {}, k, debt ? h("span", { class: "badge" }, "owed") : null), h("td", { class: "r" }, money(v))))))),
      card(
        "Accounts",
        "Balances from your statements; account numbers removed.",
        h("table", {}, h("tbody", {}, d.accounts.map((a) => h("tr", {}, h("td", {}, a.name), h("td", { class: "r" }, money(a.balance, a.balance < 0 ? "neg" : "")))))),
      ),
    ),
  );
}

function assets(c, d) {
  const sh = d.shares;
  c.append(
    card(
      "Shares and ETFs",
      `${aud(sh.total)} in all: ${sh.platforms.map((p) => `${p.name} ${aud(p.value)}`).join(" · ")}. Returns are price changes (3 and 5 years a year); max fall is the deepest drop from a high in five years.`,
      h(
        "div",
        { class: "scroll" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Holding", "Value", "Gain", "1M", "3M", "1Y", "3Y a yr", "5Y a yr", "Volatility", "Max fall"].map((t, i) => h("th", { class: i ? "r" : "" }, t)))),
          h(
            "tbody",
            {},
            sh.holdings.map((x) =>
              h(
                "tr",
                {},
                h("td", {}, h("strong", {}, x.ticker), x.geared ? h("span", { class: "badge warn" }, "Geared") : null, h("span", { class: "sub" }, `${x.platform} · ${x.units.toLocaleString("en-AU", { maximumFractionDigits: 2 })} units`)),
                h("td", { class: "r" }, money(x.value || 0)),
                h("td", { class: `r ${tone(x.gain)}` }, x.gain == null ? h("span", { class: "muted" }, "–") : money(x.gain), x.gain != null && x.cost ? h("span", { class: "sub" }, pct(x.gain / x.cost)) : null),
                ["1M", "3M", "1Y", "3Y", "5Y"].map((k) => h("td", { class: `r num ${tone(x.returns[k])}` }, pct(x.returns[k]))),
                h("td", { class: "r num" }, x.volatility == null ? "–" : `${(x.volatility * 100).toFixed(0)}%`),
                h("td", { class: "r num neg" }, pct(x.maxFall)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const g = h("div", { class: "grid2" });
  for (const p of d.property)
    g.append(
      card(
        p.name,
        p.estimate ? `From ${p.sales} like-for-like sales in the building${p.impliedGrowthPct != null ? `, which imply ${p.impliedGrowthPct}% a year` : ""}.` : "No comparable sales yet.",
        p.estimate
          ? h(
              "div",
              {},
              h("div", { class: "num" }, h("strong", {}, aud(p.estimate)), h("span", { class: "muted" }, `  likely ${aud(p.low)} to ${aud(p.high)}`)),
              valueBand(p),
              h("div", { class: "muted" }, `Recorded at ${aud(p.recorded)}`, p.likelihood != null ? ` · ${(p.likelihood * 100).toFixed(0)}% chance it is worth at least that` : ""),
            )
          : h("div", { class: "num" }, aud(p.recorded || 0)),
      ),
    );
  for (const v of d.vehicles)
    g.append(
      card(
        v.name,
        v.estimate ? `From current listings${v.km ? ` at ${v.km.toLocaleString("en-AU")} km` : ""}, below asking price.` : null,
        v.estimate
          ? h("div", {}, h("div", { class: "num" }, h("strong", {}, aud(v.estimate)), h("span", { class: "muted" }, `  likely ${aud(v.low)} to ${aud(v.high)}`)), valueBand(v), h("div", { class: "muted" }, `Recorded at ${aud(v.recorded)}`))
          : h("div", { class: "num" }, aud(v.recorded || 0)),
      ),
    );
  for (const f of d.super) {
    const last = f.points[f.points.length - 1];
    g.append(
      card(
        f.name,
        f.cagr != null ? `${pct(f.cagr)} a year since ${date(f.points[0].date)}, contributions included.` : null,
        h("div", { class: "num" }, h("strong", {}, aud(last.balance)), h("span", { class: "muted" }, `  at ${date(last.date)}`)),
        h("table", {}, h("tbody", {}, f.points.map((p) => h("tr", {}, h("td", {}, date(p.date)), h("td", { class: "r" }, money(p.balance)))))),
      ),
    );
  }
  c.append(g);
}

function pnl(c, d) {
  const pl = d.pnl;
  const maxCost = Math.max(1, ...pl.costs.map((x) => x.amount));
  c.append(
    h("div", { class: "tiles" }, tile("Income", aud(pl.totals.income)), tile("Costs", aud(pl.totals.costs)), tile(pl.totals.net >= 0 ? "Profit" : "Loss", aud(pl.totals.net)), tile("Invested", aud(pl.totals.investing))),
    h(
      "div",
      { class: "grid2" },
      card(
        "Costs, last 12 months",
        `${date(pl.from)} to ${date(pl.to)}. Transfers between your own accounts are left out.`,
        h(
          "table",
          {},
          h(
            "tbody",
            {},
            pl.costs.map((x) =>
              h("tr", {}, h("td", {}, x.category, h("span", { class: "sub" }, x.bucket), h("div", { class: "bar", style: { width: `${((x.amount / maxCost) * 100).toFixed(1)}%`, marginTop: "4px" } })), h("td", { class: "r" }, money(x.amount))),
            ),
          ),
        ),
      ),
      card("Income, last 12 months", null, h("table", {}, h("tbody", {}, pl.income.map((x) => h("tr", {}, h("td", {}, x.category), h("td", { class: "r" }, money(x.amount))))))),
    ),
  );
}

function spending(c, d) {
  const months = [...new Set(d.spending.map((x) => x.month))].sort();
  const groups = GROUPS.filter((g) => d.spending.some((x) => x.group === g));
  const rows = months.map((m) => Object.fromEntries([["month", m], ...groups.map((g) => [g, d.spending.filter((x) => x.month === m && x.group === g).reduce((a, x) => a + x.amount, 0)])]));
  const totals = groups.map((g) => [g, rows.reduce((a, r) => a + r[g], 0)]).sort((a, b) => b[1] - a[1]);
  const all = totals.reduce((a, [, v]) => a + v, 0) || 1;
  c.append(
    card("Spending by month", "Expenses by group; transfers, investing and debt principal are not spending.", legend(groups.map((g) => [g, groupColour(g)])), stackedBars(rows, groups, groupColour)),
    h(
      "div",
      { class: "grid2" },
      card(
        "By group, 12 months",
        null,
        h("table", {}, h("tbody", {}, totals.map(([g, v]) => h("tr", {}, h("td", {}, h("i", { class: "dot", style: { background: groupColour(g) } }), g), h("td", { class: "r num" }, `${((v / all) * 100).toFixed(0)}%`), h("td", { class: "r" }, money(v)))))),
      ),
      card(
        "Cash in against expenses",
        "Each month's income and its expenses.",
        legend([
          ["Cash in", "var(--g3)"],
          ["Expenses", "var(--g2)"],
        ]),
        groupedBars(
          d.cash.map((m) => ({ month: `${m.month}-01`, cashIn: m.cashIn, expenses: m.expenses })),
          [
            { key: "cashIn", label: "Cash in", colour: "var(--g3)" },
            { key: "expenses", label: "Expenses", colour: "var(--g2)" },
          ],
        ),
      ),
    ),
  );
}

function transactions(c, d) {
  const all = d.transactions;
  const accounts = [...new Set(all.map((t) => t.account))].sort();
  const cats = [...new Set(all.map((t) => t.category).filter(Boolean))].sort();
  const q = h("input", { type: "search", placeholder: "Search descriptions and details", "aria-label": "Search" });
  const acct = h("select", { "aria-label": "Account" }, h("option", { value: "" }, "All accounts"), accounts.map((a) => h("option", { value: a }, a)));
  const cat = h("select", { "aria-label": "Category" }, h("option", { value: "" }, "All categories"), h("option", { value: "-" }, "Needs a category"), cats.map((x) => h("option", { value: x }, x)));
  const sort = h("select", { "aria-label": "Sort" }, h("option", { value: "date" }, "Newest first"), h("option", { value: "amount" }, "Largest first"));
  const summary = h("p", { class: "muted" });
  const body = h("tbody");
  const more = h("button", { type: "button", class: "ghost" }, "Show more");
  let shown = 200;
  const filtered = () => {
    const needle = q.value.trim().toLowerCase();
    let rows = all.filter(
      (t) =>
        (!acct.value || t.account === acct.value) &&
        (!cat.value || (cat.value === "-" ? !t.category && !t.transfer : t.category === cat.value)) &&
        (!needle || `${t.description} ${t.detail ?? ""} ${t.category ?? ""}`.toLowerCase().includes(needle)),
    );
    if (sort.value === "amount") rows = [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return rows;
  };
  const draw = () => {
    const rows = filtered();
    const inflow = rows.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    const out = rows.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
    summary.textContent = `${rows.length.toLocaleString("en-AU")} transactions · in ${aud(inflow, 2)} · out ${aud(out, 2)}`;
    body.replaceChildren(
      ...rows.slice(0, shown).map((t) =>
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
        ),
      ),
    );
    more.hidden = rows.length <= shown;
  };
  for (const el of [acct, cat, sort]) el.addEventListener("change", () => ((shown = 200), draw()));
  q.addEventListener("input", () => ((shown = 200), draw()));
  more.addEventListener("click", () => ((shown += 200), draw()));
  c.append(
    card(
      "Transactions",
      "Every confirmed transaction. Card, account and reference numbers are removed from the text.",
      h("div", { class: "filters" }, q, acct, cat, sort),
      summary,
      h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Date", "Description", "Account", "Category", "Amount"].map((t, i) => h("th", { class: i === 4 ? "r" : "" }, t)))), body)),
      h("div", { class: "more" }, more),
    ),
  );
  draw();
}

function exceptional(c, d) {
  const e = d.exceptional;
  const marked = e.items.filter((i) => i.marked);
  const suggested = e.items.filter((i) => !i.marked);
  const row = (i) =>
    h(
      "tr",
      {},
      h("td", { class: "nowrap" }, date(i.date)),
      h(
        "td",
        {},
        i.description,
        i.marked ? h("span", { class: "badge" }, "Marked") : null,
        i.strength ? h("span", { class: `badge ${i.strength === "strong" ? "warn" : ""}` }, i.strength === "strong" ? "Strong" : "Possible") : null,
        i.reason ? h("span", { class: "sub" }, i.reason) : null,
      ),
      h("td", {}, i.category),
      h("td", { class: `r nowrap ${i.kind === "income" ? "pos" : ""}` }, money(i.kind === "income" ? i.amount : -i.amount)),
    );
  const table = (rows) =>
    h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Date", "Transaction", "Category", "Amount"].map((t, i) => h("th", { class: i === 3 ? "r" : "" }, t)))), h("tbody", {}, rows.map(row))));
  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Marked exceptional", String(marked.length), `${suggested.length} more suggested`),
      tile("Costs, everything", aud(e.withAll.costs)),
      tile("Costs without exceptional", aud(e.without.costs), e.withAll.costs ? `${(((e.withAll.costs - e.without.costs) / e.withAll.costs) * 100).toFixed(1)}% less` : null),
      tile("Profit without exceptional", aud(e.without.net), `against ${aud(e.withAll.net)} with them`),
    ),
    card("Marked", `One-offs the app leaves out when its switch is set to Left out (${date(e.from)} to ${date(e.to)}).`, marked.length ? table(marked) : h("p", { class: "muted" }, "None marked.")),
    card("Suggested", "Large or unusual against your own pattern; not marked yet.", table(suggested)),
  );
}

function tax(c, d) {
  const sel = h("div", { class: "pills", role: "group", "aria-label": "Financial year" });
  const body = h("div", { class: "stack" });
  const TREAT = { income: "Income", claim: "Claim", confirm: "Confirm first", spread: "Spread", depreciate: "Depreciate", capital: "Capital", private: "Private", credit: "Tax credit", check: "Cross-check", gain: "Gain", "gain (discount)": "Gain (50% discount)", loss: "Loss" };
  const res = (x) => (x.result > 0 ? `${aud(x.result, 2)} to pay` : `${aud(-x.result, 2)} refund`);
  const show = (i) => {
    sel.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", j === i));
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
    body.replaceChildren(
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
        h(
          "div",
          { class: "scroll" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, ""), e.cases.map((x) => h("th", { class: "r" }, `${x.pct}%${x.pct === e.chosenPct ? " (yours)" : ""}`)))),
            h(
              "tbody",
              {},
              rowsSpec.map(([label, f]) => h("tr", {}, h("td", {}, label), e.cases.map((x) => h("td", { class: "r" }, money(f(x)))))),
              h("tr", {}, h("td", {}, h("strong", {}, "Result")), e.cases.map((x) => h("td", { class: `r ${x.result > 0 ? "neg" : "pos"}` }, h("strong", {}, res(x))))),
            ),
          ),
        ),
      ),
      ...t.buckets
        .filter((b) => b.lines.length)
        .map((b) =>
          card(
            b.title,
            b.note,
            h(
              "div",
              { class: "scroll" },
              h(
                "table",
                {},
                h(
                  "tbody",
                  {},
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
          ),
        ),
    );
  };
  d.tax.forEach((t, i) => {
    const b = h("button", { type: "button", class: "pill" }, t.fy);
    b.addEventListener("click", () => show(i));
    sel.append(b);
  });
  c.append(sel, body);
  // The last complete year first (the one being lodged).
  show(Math.max(0, d.tax.length - 2));
}

/** Net worth against age (x is a number, not a date). */
function ageChart(series) {
  const W = 760;
  const H = 260;
  const pad = { l: 58, r: 12, t: 10, b: 24 };
  const xs = series[0].points.map((p) => p.x);
  const all = series.flatMap((sr) => sr.points.map((p) => p.y));
  const lo = Math.min(0, ...all);
  const hi = Math.max(1, ...all);
  const X = (i) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, xs.length - 1);
  const Y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Net worth by age" });
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)" }), s("text", { x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, audK(v)));
  }
  const step = Math.ceil(xs.length / 10);
  xs.forEach((x, i) => {
    if (i % step === 0 || i === xs.length - 1) svg.append(s("text", { x: X(i), y: H - 6, "text-anchor": i === xs.length - 1 ? "end" : "middle" }, `Age ${x}`));
  });
  for (const sr of series) svg.append(s("path", { d: sr.points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(""), fill: "none", stroke: sr.colour, "stroke-width": 2 }));
  xs.forEach((x, i) => {
    const w = (W - pad.l - pad.r) / Math.max(1, xs.length - 1);
    svg.append(s("rect", { x: X(i) - w / 2, y: pad.t, width: w, height: H - pad.t - pad.b, fill: "transparent" }, s("title", {}, `Age ${x}\n${series.map((sr) => `${sr.label}: ${aud(sr.points[i].y)}`).join("\n")}`)));
  });
  return svg;
}

function forecast(c, d) {
  const f = d.forecast;
  const COL = { invest: "var(--g7)", loan: "var(--g1)", split: "var(--g3)", cash: "var(--g4)" };
  const a = f.assumptions; // amounts here are whole dollars, as the app keeps them
  const at = (sc) => sc.years.find((y) => y.age === a.retireAge) ?? sc.years[sc.years.length - 1];
  c.append(
    h(
      "div",
      { class: "tiles" },
      f.scenarios.map((sc) =>
        tile(
          sc.label + (sc.key === f.plan ? " (your plan)" : ""),
          aud(at(sc).netWorth),
          `net worth at ${a.retireAge}${sc.mortgageFreeAge ? ` · mortgage free at about ${Math.floor(sc.mortgageFreeAge)}` : ""}${sc.earlyRetirementAge ? ` · could stop work at about ${Math.floor(sc.earlyRetirementAge)}` : ""}`,
        ),
      ),
    ),
    card(
      "Net worth by age, in today's dollars",
      "Where today's balances lead under four ways of using your monthly savings, at the app's default assumptions. A planning sketch, not advice.",
      legend(f.scenarios.map((sc) => [sc.label, COL[sc.key] ?? "var(--g9)", true])),
      ageChart(f.scenarios.map((sc) => ({ label: sc.label, colour: COL[sc.key] ?? "var(--g9)", points: sc.years.map((y) => ({ x: y.age, y: y.netWorth })) }))),
    ),
    card(
      "Assumptions",
      null,
      h(
        "table",
        {},
        h(
          "tbody",
          {},
          [
            ["Age today", a.age],
            ["Work until", a.retireAge],
            ["Monthly savings", aud(a.monthlySavings * 100)],
            ["Living costs a year", aud(a.livingCosts * 100)],
            ["Net rent a year", aud(a.netRent * 100)],
            ["Cost inflation", `${a.inflationPct}%`],
            ["Pay growth", `${a.salaryGrowthPct}%`],
            ["Property growth", `${a.propertyGrowthPct}%`],
            ["Shares return", `${a.sharesReturnPct}%`],
            ["Super return", `${a.superReturnPct}%`],
            ["Mortgage rate", `${a.loanRatePct}%`],
          ].map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", { class: "r num" }, String(v)))),
        ),
      ),
    ),
  );
}

function bills(c, d) {
  c.append(
    card(
      "Upcoming bills",
      "Expected from your history.",
      d.bills.length
        ? h("table", {}, h("tbody", {}, d.bills.map((b) => h("tr", {}, h("td", {}, b.name, h("span", { class: "sub" }, `${date(b.expected)} · ${b.cadence}`)), h("td", { class: "r" }, money(Math.abs(b.amount)))))))
        : h("p", { class: "muted" }, "None expected."),
    ),
  );
}

function render(d) {
  DATA = d;
  $("asof").textContent = `As at ${date(d.asOf)}`;
  $("foot").textContent = `Read-only summary made ${new Date(d.generatedAt).toLocaleString("en-AU")}. Account, card and reference numbers are removed.`;
  route();
}
window.addEventListener("hashchange", route);


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
  // Forget the decrypted figures, not just hide them.
  DATA = null;
  $("content").replaceChildren();
  $("tabs").replaceChildren();
  $("app").hidden = true;
  $("lock").hidden = false;
  $("pw").focus();
});
