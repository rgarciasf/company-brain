/* Rendering helpers shared by the app (index.html) and shared reports (report.html). */
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Validated categorical palette (fixed order, never cycled) - light and dark steps.
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  };
  const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const palette = () => (isDark() ? PALETTE.dark : PALETTE.light);
  const ink = () => (isDark() ? { text: "#c3c2b7", grid: "rgba(255,255,255,.08)", axis: "rgba(255,255,255,.25)" } : { text: "#52514e", grid: "rgba(0,0,0,.06)", axis: "rgba(0,0,0,.25)" });

  const num = (v) => (typeof v === "number" ? v : Number(v));
  const fmtNum = (v, unit) => {
    const n = num(v);
    if (!Number.isFinite(n)) return String(v ?? "");
    const abs = Math.abs(n);
    const s = abs >= 1e9 ? (n / 1e9).toFixed(1) + "B" : abs >= 1e6 ? (n / 1e6).toFixed(1) + "M" : abs >= 1e4 ? (n / 1e3).toFixed(1) + "K" : Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return unit === "USD" || unit === "$" ? "$" + s : unit === "%" ? s + "%" : unit ? `${s} ${unit}` : s;
  };
  const fmtCell = (v) => (v === null || v === undefined ? "∅" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 4 })) : typeof v === "object" ? JSON.stringify(v) : String(v));
  const fmtLabel = (v) => {
    const s = String(v ?? "");
    return /^\d{4}-\d{2}-\d{2} 00:00:00$/.test(s) ? s.slice(0, 10) : s;
  };

  /** Markdown answer -> HTML with numbered citation chips for doc chunks [c12] and data queries [q3]. */
  function renderAnswer(md, lookup) {
    const order = [];
    const tokenized = md.replace(/\[((?:c|q)\d+(?:\s*[,;]\s*(?:c|q)\d+)*)\]/g, (_m, ids) => ids.split(/\s*[,;]\s*/).map((id) => `⟦${id}⟧`).join(""));
    let html = DOMPurify.sanitize(marked.parse(tokenized));
    html = html.replace(/⟦((?:c|q)\d+)⟧/g, (_m, id) => {
      if (!order.includes(id)) order.push(id);
      const n = order.indexOf(id) + 1;
      const item = lookup(id);
      const isQuery = id.startsWith("q");
      const title = item ? (isQuery ? `SQL: ${item.purpose || item.sql}` : `${item.title}${item.heading ? " › " + item.heading : ""}`) : id;
      return `<a href="#" class="cite ${isQuery ? "cite-q" : ""}" data-cite="${id}" title="${esc(title)}">${n}</a>`;
    });
    const refs = order
      .map((id, i) => {
        const item = lookup(id);
        if (!item) return "";
        if (id.startsWith("q")) {
          return `<div class="ref" data-cite="${id}"><span class="num q">${i + 1}</span><span>📊 ${esc(item.purpose || "Query")}</span><span class="pill">SQL ${esc(id)}</span><span class="pill">${fmtNum(item.rowsRead)} rows scanned · ${item.elapsedMs} ms</span></div>`;
        }
        return `<div class="ref" data-cite="${id}"><span class="num">${i + 1}</span><span>${esc(item.title)}${item.heading ? ` › ${esc(item.heading)}` : ""}</span>
          <span class="pill">${esc(item.sourceType)}</span>${item.updated ? `<span class="pill">${esc(item.updated)}</span>` : ""}${item.status === "superseded" ? `<span class="pill superseded">superseded</span>` : ""}</div>`;
      })
      .join("");
    return `<div class="md">${html}</div>${refs ? `<div class="refs"><div class="muted small">Sources</div>${refs}</div>` : ""}`;
  }

  function tableHtml(columns, rows, max = 200) {
    const cols = columns.map((c) => c.name ?? c);
    return `<div class="table-wrap"><table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .slice(0, max)
      .map((r) => `<tr>${cols.map((c) => `<td class="${typeof r[c] === "number" ? "n" : ""}">${esc(fmtCell(r[c]))}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>${rows.length > max ? `<div class="muted small">Showing ${max} of ${rows.length} rows</div>` : ""}</div>`;
  }

  /** Build Chart.js datasets from a long or wide result set. */
  function datasets(spec) {
    const labels = [...new Set(spec.rows.map((r) => fmtLabel(r[spec.x])))];
    const colors = palette();
    let series;
    if (spec.series) {
      const totals = new Map();
      for (const r of spec.rows) totals.set(String(r[spec.series]), (totals.get(String(r[spec.series])) ?? 0) + Math.abs(num(r[spec.y[0]]) || 0));
      const keys = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      series = keys.slice(0, 8).map((k) => {
        const byX = new Map(spec.rows.filter((r) => String(r[spec.series]) === k).map((r) => [fmtLabel(r[spec.x]), num(r[spec.y[0]])]));
        return { name: k, values: labels.map((l) => byX.get(l) ?? null) };
      });
      series.truncated = keys.length > 8 ? keys.length - 8 : 0;
    } else {
      series = spec.y.slice(0, 8).map((col) => {
        const byX = new Map(spec.rows.map((r) => [fmtLabel(r[spec.x]), num(r[col])]));
        return { name: col, values: labels.map((l) => byX.get(l) ?? null) };
      });
    }
    return {
      labels,
      truncated: series.truncated,
      sets: series.map((s, i) => ({ label: s.name, data: s.values, color: colors[i] })),
    };
  }

  const charts = new WeakMap();

  /** Render a chart spec ({type,title,x,y,series,unit,columns,rows}) into an element. */
  function renderChart(el, spec) {
    el.classList.add("chart-card");
    const head = `<div class="chart-head"><div><div class="chart-title">${esc(spec.title)}</div><div class="muted small">${esc(spec.queryId ? `from ${spec.queryId}` : "")}</div></div>
      ${spec.type !== "table" && spec.type !== "number" ? `<button class="small-btn" data-toggle-table>Table</button>` : ""}</div>`;
    if (spec.type === "number") {
      const v = spec.rows[0]?.[spec.y[0]];
      el.innerHTML = `${head}<div class="hero-number">${esc(fmtNum(v, spec.unit))}</div><div class="muted small">${esc(spec.y[0])}</div>`;
      return;
    }
    if (spec.type === "table" || typeof Chart === "undefined") {
      el.innerHTML = head + tableHtml(spec.columns ?? Object.keys(spec.rows[0] ?? {}), spec.rows);
      return;
    }
    const d = datasets(spec);
    el.innerHTML = `${head}<div class="chart-box"><canvas></canvas></div><div class="chart-table" hidden>${tableHtml(spec.columns ?? Object.keys(spec.rows[0] ?? {}), spec.rows)}</div>
      ${d.truncated ? `<div class="muted small">Showing the 8 largest series; ${d.truncated} more in the table view.</div>` : ""}`;
    el.querySelector("[data-toggle-table]").onclick = (e) => {
      const t = el.querySelector(".chart-table");
      t.hidden = !t.hidden;
      el.querySelector(".chart-box").hidden = !t.hidden;
      e.target.textContent = t.hidden ? "Table" : "Chart";
    };
    const c = ink();
    const isLine = spec.type === "line" || spec.type === "area";
    const multi = d.sets.length > 1;
    const chart = new Chart(el.querySelector("canvas"), {
      type: isLine ? "line" : "bar",
      data: {
        labels: d.labels,
        datasets: d.sets.map((s) => ({
          label: s.label,
          data: s.data,
          borderColor: s.color,
          backgroundColor: isLine ? s.color + (spec.type === "area" ? "33" : "") : s.color,
          fill: spec.type === "area",
          borderWidth: isLine ? 2 : 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
          spanGaps: true,
          borderRadius: isLine ? 0 : 4,
          borderSkipped: "start",
          maxBarThickness: 36,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        interaction: { mode: isLine ? "index" : "nearest", intersect: !isLine },
        plugins: {
          legend: { display: multi, position: "top", align: "start", labels: { color: c.text, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtNum(ctx.parsed.y, spec.unit)}` } },
        },
        scales: {
          x: { stacked: spec.type === "stacked_bar", ticks: { color: c.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false }, border: { color: c.axis } },
          y: {
            stacked: spec.type === "stacked_bar",
            beginAtZero: !isLine || d.sets.every((s) => s.data.every((v) => v === null || v >= 0)),
            ticks: { color: c.text, callback: (v) => fmtNum(v, spec.unit), maxTicksLimit: 6 },
            grid: { color: c.grid },
            border: { display: false },
          },
        },
      },
    });
    charts.set(el, chart);
  }

  function queryHtml(q) {
    const stats = q.error
      ? `<div class="error">${esc(q.error)}</div>`
      : `<div class="muted small">${q.rowCount?.toLocaleString?.() ?? 0} rows · scanned ${fmtNum(q.rowsRead)} rows (${fmtNum(q.bytesRead)}B) in ${q.elapsedMs} ms${q.approval === "approved" ? " · ✅ approved by user" : ""}</div>`;
    return `<div class="query-block"><div class="query-head"><strong>${esc(q.id)}</strong> <span>${esc(q.purpose || "")}</span></div>
      <pre class="sql">${esc(q.sql)}</pre>${stats}${q.rows?.length ? tableHtml(q.columns, q.rows, 50) : ""}</div>`;
  }

  window.BrainUI = { esc, renderAnswer, renderChart, tableHtml, queryHtml, fmtNum, palette };
})();
