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
    if (i % step === 0 || i === xs.length - 1) svg.append(s("text", { x: X(i), y: H - 6, "text-anchor": "middle" }, monthLabel(x)));
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

// ---------- page ----------
function render(d) {
  $("asof").textContent = `As at ${date(d.asOf)}`;
  const c = $("content");
  c.replaceChildren();
  const nw = d.netWorth;
  const assets = Object.values(nw.assets).reduce((a, b) => a + b, 0);
  const debts = Object.values(nw.liabilities).reduce((a, b) => a + b, 0);
  const first = nw.history[0];

  c.append(
    h(
      "div",
      { class: "tiles" },
      tile("Net worth", aud(nw.current), first ? `${aud(nw.current - first.netWorth)} since ${date(first.date)}` : null),
      tile("Accessible wealth", aud(nw.accessible), "Cash, offset and shares"),
      tile("Assets", aud(assets)),
      tile("Debts", aud(debts)),
    ),
  );

  c.append(
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
      card(
        "Today, by class",
        null,
        h("table", {}, h("tbody", {}, classRows.map(([k, v, debt]) => h("tr", {}, h("td", {}, k, debt ? h("span", { class: "badge" }, "owed") : null), h("td", { class: "r" }, money(v)))))),
      ),
      card(
        "Accounts",
        "Balances from your statements; account numbers removed.",
        h("table", {}, h("tbody", {}, d.accounts.map((a) => h("tr", {}, h("td", {}, a.name), h("td", { class: "r" }, money(a.balance, a.balance < 0 ? "neg" : "")))))),
      ),
    ),
  );

  // Shares.
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

  // Property, car, super.
  const assetsGrid = h("div", { class: "grid2" });
  for (const p of d.property) {
    assetsGrid.append(
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
  }
  for (const v of d.vehicles) {
    assetsGrid.append(
      card(
        v.name,
        v.estimate ? `From current listings${v.km ? ` at ${v.km.toLocaleString("en-AU")} km` : ""}, below asking price.` : null,
        v.estimate
          ? h("div", {}, h("div", { class: "num" }, h("strong", {}, aud(v.estimate)), h("span", { class: "muted" }, `  likely ${aud(v.low)} to ${aud(v.high)}`)), valueBand(v), h("div", { class: "muted" }, `Recorded at ${aud(v.recorded)}`))
          : h("div", { class: "num" }, aud(v.recorded || 0)),
      ),
    );
  }
  for (const f of d.super) {
    const last = f.points[f.points.length - 1];
    assetsGrid.append(
      card(
        f.name,
        f.cagr != null ? `${pct(f.cagr)} a year since ${date(f.points[0].date)}, contributions included.` : null,
        h("div", { class: "num" }, h("strong", {}, aud(last.balance)), h("span", { class: "muted" }, `  at ${date(last.date)}`)),
        h("table", {}, h("tbody", {}, f.points.map((p) => h("tr", {}, h("td", {}, date(p.date)), h("td", { class: "r" }, money(p.balance)))))),
      ),
    );
  }
  c.append(assetsGrid);

  // Profit and loss.
  const pl = d.pnl;
  const topCosts = pl.costs.slice(0, 12);
  const maxCost = Math.max(1, ...topCosts.map((x) => x.amount));
  c.append(
    card(
      "Profit and loss, last 12 months",
      `${date(pl.from)} to ${date(pl.to)}. Transfers between your own accounts are left out.`,
      h(
        "div",
        { class: "tiles" },
        tile("Income", aud(pl.totals.income)),
        tile("Costs", aud(pl.totals.costs)),
        tile(pl.totals.net >= 0 ? "Profit" : "Loss", aud(pl.totals.net)),
        tile("Invested", aud(pl.totals.investing)),
      ),
      h(
        "div",
        { class: "grid2" },
        h(
          "div",
          {},
          h("h3", { class: "muted" }, "Largest costs"),
          h(
            "table",
            {},
            h(
              "tbody",
              {},
              topCosts.map((x) =>
                h("tr", {}, h("td", {}, x.category, h("div", { class: "bar", style: { width: `${((x.amount / maxCost) * 100).toFixed(1)}%`, marginTop: "4px" } })), h("td", { class: "r" }, money(x.amount))),
              ),
            ),
          ),
        ),
        h("div", {}, h("h3", { class: "muted" }, "Income"), h("table", {}, h("tbody", {}, pl.income.map((x) => h("tr", {}, h("td", {}, x.category), h("td", { class: "r" }, money(x.amount))))))),
      ),
    ),
  );

  // Spending by group per month.
  const months = [...new Set(d.spending.map((x) => x.month))].sort();
  const groups = GROUPS.filter((g) => d.spending.some((x) => x.group === g));
  const rows = months.map((m) => Object.fromEntries([["month", m], ...groups.map((g) => [g, d.spending.filter((x) => x.month === m && x.group === g).reduce((a, x) => a + x.amount, 0)])]));
  c.append(card("Spending by month", "Expenses by group; transfers, investing and debt principal are not spending.", legend(groups.map((g) => [g, groupColour(g)])), stackedBars(rows, groups, groupColour)));

  // Cash in against expenses.
  c.append(
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
  );

  if (d.bills.length)
    c.append(
      card(
        "Upcoming bills",
        "Expected from your history.",
        h("table", {}, h("tbody", {}, d.bills.map((b) => h("tr", {}, h("td", {}, b.name, h("span", { class: "sub" }, `${date(b.expected)} · ${b.cadence}`)), h("td", { class: "r" }, money(Math.abs(b.amount))))))),
      ),
    );

  c.append(h("p", { class: "foot" }, `Read-only summary made ${new Date(d.generatedAt).toLocaleString("en-AU")}. No transactions or account numbers are included.`));
}

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
  $("content").replaceChildren();
  $("app").hidden = true;
  $("lock").hidden = false;
  $("pw").focus();
});
