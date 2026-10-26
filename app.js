// amv-site 前端逻辑
const COLORS = {
  official: "#d64545",
  var1: "var(--muted)",
  c5: "#3b6fe0",
  c13: "#2fa36b",
  c34: "#b8860b",
  cinf: "#7c5cbf",
  amv_hat: "#e07b3b",
  znz0: "#3b6fe0",
  dmv: "var(--muted)",
};

let D = null;
let mainLegendInit = false; // 官方 0AMV 图例开关只在首次初始化时设置，重绘时保持用户选择
let MODE = "amt";        // amt = 成交额口径, reg = 公式口径, dma = 流传DMA版
let CURRENT_SECTOR = null; // null = 全市场
let VIEW_RANGE = null;     // null = 最新；否则 [start, end]
let RANGE_SORT = "amount"; // amount = 区间累计成交额；drag = 拖后腿榜（活跃市值变化升序）
let SEC_TAB = "industry"; // industry = 行业榜；style = 风格榜
let SHOW_DROP = true;    // −2.3% 事件标记开关

function checkDataFreshness() {
  // 数据比昨天旧 → 提示可能是网络缓存了旧数据
  try {
    const up = String(D.updated_at || "").slice(0, 10);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (up && up < today) {
      const m = document.getElementById("meta");
      if (m) {
        m.innerHTML = `<span style="color:#b9770e;font-weight:bold;">⚠️ 你加载到的是 ${up} 的旧数据（当前 ${today}）——网络/运营商缓存了旧文件。请尝试：手机切换流量、清除浏览器缓存、或换浏览器打开。</span>`;
      }
    }
  } catch (e) { }
}

async function load() {
  // 优先拉 gzip 压缩版（手机快 3 倍+）；不支持或失败回退 window.DATA
  if (typeof DecompressionStream !== "undefined") {
    try {
      const r = await fetch("d2.js.gz?v=" + new Date().getTime());
      if (r.ok) {
        const buf = await r.arrayBuffer();
        const ds = new DecompressionStream("gzip");
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        const txt = await new Response(stream).text();
        D = JSON.parse(txt.slice(txt.indexOf("{")).replace(/;\s*$/, ""));
        if (!D.bull_bear) {
          try {
            const r2 = await fetch("bull_bear.json?v=" + new Date().getTime());
            D.bull_bear = await r2.json();
          } catch (e2) { }
        }
        checkDataFreshness();
      }
    } catch (e) { }
  }
  if (!D) D = window.DATA;
  if (!D) return;
  const snaps = D.history_snaps || {};
  const days = Object.keys(snaps).sort();
  if (days.length) {
    document.getElementById("histRange").textContent =
      `可回看范围（个股/板块）：${days[0]} ~ ${days[days.length - 1]}（官方序列全历史可查）`;
  } else {
    document.getElementById("histRange").textContent =
      "个股/板块历史快照采集中（每日自动补充）";
  }
  renderMeta();
  renderMain();
  renderTrio();
  renderRatio();
  renderWeekly();
  renderSectors();
  renderStocks();
}

function applyRange() {
  const s = document.getElementById("dateStart").value;
  const e = document.getElementById("dateEnd").value;
  if (!s || !e) return;
  if (s > e) { alert("开始日期不能晚于结束日期"); return; }
  VIEW_RANGE = [s, e];
  CURRENT_SECTOR = null;
  document.getElementById("backBtn2").style.display = "none";
  // 图表裁剪到区间
  for (const id of ["chartMain", "chartTrio", "chartRatio"]) {
    const ch = echarts.getInstanceByDom(document.getElementById(id));
    if (ch) {
      ch.setOption({
        dataZoom: [
          { startValue: s, endValue: e },
          { startValue: s, endValue: e },
        ],
      });
    }
  }
  renderRangeStocks(s, e);
}

function renderRangeStocks(s, e) {
  const snaps = D.history_snaps || {};
  const days = Object.keys(snaps).filter(d => d >= s && d <= e).sort();
  const full = D.official_full || {};
  const fi0 = (full.date || []).findIndex(d => d >= s);
  const fi1 = (full.date || []).map((d, i) => [d, i]).reverse().find(x => x[0] <= e);
  let offTxt = "";
  if (fi0 >= 0 && fi1) {
    const a0 = full.amv[fi0], a1 = full.amv[fi1[1]];
    offTxt = ` ｜ 区间官方 0AMV：${a0.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} → ${a1.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}` +
      `（${((a1 / a0 - 1) * 100).toFixed(1)}%）`;
  }
  const el = document.getElementById("meta");
  const base = el.textContent.split("｜")[0];
  el.innerHTML = `${base} ｜ <b>区间：${s} ~ ${e}</b>${offTxt}`;

  if (!days.length) {
    document.getElementById("stockTableTitle").textContent = `${s} ~ ${e}（区间内无个股快照）`;
    document.getElementById("stockTableNote").innerHTML = "个股/板块历史快照范围见页面顶部标注。";
    document.getElementById("stockTable").innerHTML = "";
    return;
  }
  // 聚合：区间累计活跃SZ（=累计成交额）+ 首末贡献占比变化
  const agg = new Map();
  const secAgg = new Map();
  const firstDay = days[0], lastDay = days[days.length - 1];
  const firstStocks = new Map((snaps[firstDay].stocks || []).map(x => [x.code, x]));
  const lastStocks = new Map((snaps[lastDay].stocks || []).map(x => [x.code, x]));
  days.forEach(d => {
    (snaps[d].stocks || []).forEach(st => {
      let a = agg.get(st.code);
      if (!a) {
        a = { code: st.code, name: st.name, industry: st.industry, sumAmount: 0, turnSum: 0, cnt: 0, firstAmv: null, lastAmv: null };
        agg.set(st.code, a);
      }
      a.sumAmount += st.amount || 0;
      a.turnSum += st.turnover || 0;
      a.cnt++;
      if (st.amv != null) {
        if (a.firstAmv == null) a.firstAmv = st.amv;
        a.lastAmv = st.amv;
      }
      const ind = st.industry || "—";
      let sec = secAgg.get(ind);
      if (!sec) {
        sec = { amount: 0 };
        secAgg.set(ind, sec);
      }
      sec.amount += st.amount || 0;
    });
  });
  const rows = [...agg.values()].map(a => {
    const f = firstStocks.get(a.code);
    const l = lastStocks.get(a.code);
    return {
      code: a.code, name: a.name, industry: a.industry,
      amount: a.sumAmount,
      turnover: a.cnt ? a.turnSum / a.cnt : null,
      days: a.cnt,
      amv_chg: a.firstAmv && a.lastAmv ? (a.lastAmv / a.firstAmv - 1) * 100 : null,
      pct_chg: (f && l && f.amount_pct != null && l.amount_pct != null)
        ? l.amount_pct - f.amount_pct : null,
    };
  });
  const dragMode = RANGE_SORT === "drag";
  rows.sort(dragMode
    ? (x, y) => (x.pct_chg == null ? 1 : y.pct_chg == null ? -1 : x.pct_chg - y.pct_chg)
    : (x, y) => y.amount - x.amount);
  const topRows = rows.slice(0, 50);

  window._rangeAgg = agg;
  const title = dragMode
    ? `${s} ~ ${e} 拖后腿榜 Top ${topRows.length}（活跃SZ贡献占比缩水最狠的个股）`
    : `${s} ~ ${e} 区间累计活跃SZ Top ${topRows.length}（覆盖成交额前300名）`;
  renderRangeRows(topRows, title);
  document.getElementById("stockTableNote").innerHTML =
    (dragMode
      ? `按贡献占比变化从最差到最好排序（活跃SZ占比 = 个股成交额/全市场成交额，首末对比）。`
      : `按区间累计活跃SZ（=累计成交额）排序；占比变化 = 区间首末贡献占比差。`) +
    ` <button onclick="setRangeSort('amount')" style="margin-left:6px;cursor:pointer;${dragMode ? '' : 'font-weight:700;'}">贡献榜</button>` +
    ` <button onclick="setRangeSort('drag')" style="cursor:pointer;${dragMode ? 'font-weight:700;' : ''}">拖后腿榜</button>`;
  // 板块区间榜（按钮云 + 柱状图都切到区间）
  const secs = [...secAgg.entries()].map(([name, sec]) => ({ name, amount: sec.amount }))
    .sort((a, b) => b.amount - a.amount).slice(0, 15);
  const totS = secs.reduce((t, x) => t + x.amount, 0) || 1;
  secs.forEach(x => {
    x.amount_pct = +(x.amount / totS * 100).toFixed(2);
  });
  renderSectorsFor(secs, false);
  renderSectorBtns(secs, true);
}

function setRangeSort(mode) {
  RANGE_SORT = mode;
  if (VIEW_RANGE) {
    applyRange();
  }
}

function renderRangeRows(rows, title) {
  document.getElementById("stockTableTitle").textContent = title;
  const fmt = (v, d = 1) => v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  const dragMode = RANGE_SORT === "drag";
  let html = `<table><thead><tr>
    <th>#</th><th>代码</th><th>名称</th><th>行业</th><th>在榜天数</th>
    <th>区间累计活跃SZ(亿)</th><th>平均换手率</th>` +
    (dragMode ? `<th>贡献占比变化(pp)</th>` : `<th>活跃SZ变化</th>`) +
    `</tr></thead><tbody>`;
  rows.forEach((s, i) => {
    const val = dragMode ? s.pct_chg : s.amv_chg;
    const chg = val == null ? "—" : (val >= 0 ? "+" : "") + fmt(val, 2) + (dragMode ? "pp" : "%");
    const cls = val == null ? "" : (val >= 0 ? "up" : "down");
    html += `<tr><td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td>` +
      `<td>${s.days ?? "—"}</td>` +
      `<td>${fmt(s.amount / 1e8, 1)}</td><td>${fmt(s.turnover, 2)}%</td>` +
      `<td class="${cls}">${chg}</td></tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("stockTable").innerHTML = html;
}

function showRangeSector(name) {
  if (!VIEW_RANGE) return;
  const codes = new Set((D.sector_members || {})[name] || []);
  const agg = window._rangeAgg || new Map();
  const members = [...agg.values()].filter(a => codes.has(a.code));
  const rows = members
    .map(a => ({
      code: a.code, name: a.name, industry: a.industry,
      amount: a.sumAmount,
      turnover: a.cnt ? a.turnSum / a.cnt : null,
      amv_chg: a.firstAmv && a.lastAmv ? (a.lastAmv / a.firstAmv - 1) * 100 : null,
    }))
    .sort((x, y) => y.amount - x.amount)
    .slice(0, 50);
  // 板块级汇总
  const secTotal = members.reduce((t, a) => t + a.sumAmount, 0);
  const secFirst = members.reduce((t, a) => t + (a.firstAmv || 0), 0);
  const secLast = members.reduce((t, a) => t + (a.lastAmv || 0), 0);
  const secChg = secFirst ? (secLast / secFirst - 1) * 100 : null;
  const chgTxt = secChg == null ? "—" : (secChg >= 0 ? "+" : "") + secChg.toFixed(1) + "%";
  const cls = secChg == null ? "" : (secChg >= 0 ? "up" : "down");
  renderRangeRows(
    rows,
    `板块「${name}」区间累计成交额 Top ${rows.length}（${VIEW_RANGE[0]} ~ ${VIEW_RANGE[1]}）`
  );
  document.getElementById("stockTableNote").innerHTML =
    `板块区间累计成交额 <b>${(secTotal / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 亿</b>，` +
    `板块活跃市值变化 <b class="${cls}">${chgTxt}</b>。个股按区间累计成交额排序。`;
  document.getElementById("backBtn2").style.display = "inline-block";
  document.getElementById("backBtn2").textContent = "← 返回区间全市场榜";
  document.getElementById("backBtn2").onclick = () => {
    applyRange();
  };
}

function showLatest() {
  VIEW_RANGE = null;
  document.getElementById("dateStart").value = "";
  document.getElementById("dateEnd").value = "";
  for (const id of ["chartMain", "chartTrio", "chartRatio"]) {
    const ch = echarts.getInstanceByDom(document.getElementById(id));
    if (ch) {
      ch.setOption({ dataZoom: [{ start: 0, end: 100 }, { start: 0, end: 100 }] });
    }
  }
  renderMeta();
  renderSectors();
  if (CURRENT_SECTOR) showSectorStocks(CURRENT_SECTOR);
  else showMarketStocks();
}

function renderSectorsFor(secs, showChg) {
  const ch = echarts.getInstanceByDom(document.getElementById("chartSectors"));
  if (!ch) return;
  const data = secs.slice(0, 15).reverse();
  ch.setOption({
    grid: { left: 90, right: 90, top: 10, bottom: 30 },
    xAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    yAxis: { type: "category", data: data.map(s => s.name) },
    series: [{
      type: "bar", data: data.map(s => s.amount_pct), barMaxWidth: 16,
      itemStyle: { color: COLORS.blue, borderRadius: [0, 4, 4, 0] },
      label: {
        show: true, position: "right", fontSize: 11,
        formatter: p => {
          const s = data[p.dataIndex];
          let extra = "";
          if (showChg && s.amv_chg != null) {
            extra = (s.amv_chg >= 0 ? "  ▲" : "  ▼") + Math.abs(s.amv_chg).toFixed(1) + "%";
          }
          return p.value + "%" + extra;
        },
      },
    }],
  });
  ch.off("click");
  ch.on("click", onSectorClick);
}

function renderMeta() {
  const o = D.official;
  const last = o.date.length - 1;
  const r = o.ratio[last];
  const amv = o.amv[last];
  const prev = o.amv[last - 1];
  const chg = ((amv / prev - 1) * 100).toFixed(2);
  const cls = chg >= 0 ? "up" : "down";
  const src = D.official_source === "vdat"
    ? "指南针缓存（day.vdat 实时解析）"
    : D.official_source === "csv_fallback"
      ? "本地 CSV 底表（指南针运行时缓存被锁）"
      : "上次 JSON";
  document.getElementById("meta").innerHTML =
    `<span id="metaTime">数据更新：${D.updated_at}</span> ｜ 官方序列来源：${src} ｜ 最新交易日 ${o.date[last]} ` +
    `0AMV <b>${amv.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}</b> ` +
    `(<span class="${cls}">${chg >= 0 ? "+" : ""}${chg}%</span>) ` +
    `活跃比例 <b>${(r * 100).toFixed(2)}%</b> ` +
    (D.market_totals
      ? `｜ 全市场成交额 ${(D.market_totals.amount / 1e12).toFixed(2)} 万亿`
      : "") +
    (D.errors.length ? ` ｜ <span class="down">${D.errors.join("；")}</span>` : "");
  markStale(D.updated_at);
}

function markStale(updatedAt) {
  const el = document.getElementById("metaTime");
  if (!el || !updatedAt) return;
  const t = new Date(String(updatedAt).replace(" ", "T")).getTime();
  if (isNaN(t)) return;
  // 数据已覆盖最新交易日 → 不是过期（休市期间数据不更新属正常）
  const lastTrade = (D && D.official && D.official.date && D.official.date.length)
    ? D.official.date[D.official.date.length - 1] : "";
  const updDay = String(updatedAt).slice(0, 10);
  if (lastTrade && updDay >= lastTrade) {
    const now = new Date();
    const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    el.style.color = "";
    el.style.fontWeight = "";
    if (todayLocal > lastTrade) {
      el.innerHTML = `数据更新：${updatedAt}（已含最新交易日 ${lastTrade}，休市中数据不会变）`;
    }
    return;
  }
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins > 90) {
    el.style.color = "#c0392b";
    el.style.fontWeight = "bold";
    el.innerHTML = `数据更新：${updatedAt}（已滞后 ${Math.floor(mins / 60)} 小时${mins % 60} 分，云端任务可能未跑）`;
  } else if (mins > 20) {
    el.style.color = "#b9770e";
    el.innerHTML = `数据更新：${updatedAt}（${mins} 分钟前）`;
  }
}

function themeColors() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return dark
    ? { text: "#9098a8", axis: "#2e3440", split: "#2e3440", tooltipBg: "#1e222a", tooltipText: "#e8ebf2" }
    : { text: "#6b7280", axis: "#c9ccd2", split: "#eef0f3", tooltipBg: "#ffffff", tooltipText: "#1a1d24" };
}

function baseOption() {
  const tc = themeColors();
  return {
    animation: false,
    grid: { left: 55, right: 55, top: 40, bottom: 40 },
    textStyle: { color: tc.text },
    tooltip: { trigger: "axis", backgroundColor: tc.tooltipBg, borderColor: tc.axis,
               textStyle: { color: tc.tooltipText, fontSize: 12 } },
  };
}

function renderMain() {
  const o = D.official, s = D.self;
  const dom = document.getElementById("chartMain");
  const ch = echarts.getInstanceByDom(dom) || echarts.init(dom);
  const opt = baseOption();
  opt.legend = { top: 0, data: ["官方 0AMV", "活跃SZ(逐股递推·实测)", "var1(成交额平滑)", "C5", "C13", "C34", "∞"] };
  // 逐股递推序列对齐官方日期
  const ps = D.amv_perstock || { date: [], amv: [] };
  const psMap = {};
  for (let i = 0; i < ps.date.length; i++) psMap[ps.date[i]] = ps.amv[i];
  const psAligned = o.date.map(d => (d in psMap ? psMap[d] : null));
  opt.xAxis = { type: "category", data: o.date };
  opt.yAxis = { type: "value", scale: true };
  opt.dataZoom = [
    { type: "inside", xAxisIndex: 0 },
    { type: "slider", xAxisIndex: 0, bottom: 5, height: 16 },
  ];
  {
    const total = o.date.length;
    const st = Math.max(0, (1 - 500 / total) * 100);
    opt.dataZoom[0].start = st; opt.dataZoom[0].end = 100;
    opt.dataZoom[1].start = st; opt.dataZoom[1].end = 100;
  }
  opt.series = [
    line(o.amv, "官方 0AMV", COLORS.official, 2.5),
    { name: "活跃SZ(逐股递推·实测)", type: "line", data: psAligned, showSymbol: false,
      lineStyle: { width: 2.5, color: "#16a085" }, itemStyle: { color: "#16a085" } },
    line(o.ma10 || [], "MA10", "#e67e22", 1.2),
    line(o.ma80 || [], "MA80(80天周期)", "#2980b9", 1.2),
    line(s.var1, "var1(成交额平滑)", COLORS.var1, 1),
    line(s.c5, "C5", COLORS.c5, 1),
    line(s.c13, "C13", COLORS.c13, 1),
    line(s.c34, "C34", COLORS.c34, 1),
    line(s.cinf, "∞", COLORS.cinf, 1),
  ];
  // −2.3% 事件标记（可开关，近 500 日窗口内）
  if (SHOW_DROP) {
    const dropPts = (D.drop_events || [])
      .filter(e => o.date[0] <= e.date && e.date <= o.date[o.date.length - 1])
      .map(e => ({ coord: [e.date, o.amv[o.date.indexOf(e.date)]], value: e.chg + "%" }));
    if (dropPts.length) {
      opt.series[0].markPoint = {
        symbol: "pin", symbolSize: 26,
        label: { show: true, fontSize: 9, formatter: p => p.data.value },
        itemStyle: { color: "#c0392b" },
        data: dropPts,
      };
    }
  }
  // 官方 0AMV 默认隐藏（不参与比对，点图例可叠加）——仅在首次初始化时执行一次
  opt.series[0].lineStyle.opacity = 0.9;
  ch.setOption(opt);
  if (!mainLegendInit) {
    ch.dispatchAction({ type: "legendToggleSelect", name: "官方 0AMV" });
    mainLegendInit = true;
  }
  window.addEventListener("resize", () => ch.resize());
}

function renderTrio() {
  const o = D.official;
  const dom = document.getElementById("chartTrio");
  const ch = echarts.getInstanceByDom(dom) || echarts.init(dom);
  const opt = baseOption();
  opt.legend = { top: 0, data: ["0号指数(流通市值)", "0AMV(活跃)", "0DMV(死筹)"] };
  opt.xAxis = { type: "category", data: o.date };
  opt.yAxis = { type: "value", scale: true };
  opt.dataZoom = [
    { type: "inside", xAxisIndex: 0 },
    { type: "slider", xAxisIndex: 0, bottom: 5, height: 16 },
  ];
  {
    const total = o.date.length;
    const st = Math.max(0, (1 - 500 / total) * 100);
    opt.dataZoom[0].start = st; opt.dataZoom[0].end = 100;
    opt.dataZoom[1].start = st; opt.dataZoom[1].end = 100;
  }
  opt.series = [
    line(o.znz0, "0号指数(流通市值)", COLORS.znz0, 2),
    line(o.amv, "0AMV(活跃)", COLORS.official, 2.5),
    line(o.dmv, "0DMV(死筹)", COLORS.dmv, 1),
  ];
  ch.setOption(opt);
  window.addEventListener("resize", () => ch.resize());
}

function renderRatio() {
  const o = D.official;
  const dom = document.getElementById("chartRatio");
  const ch = echarts.getInstanceByDom(dom) || echarts.init(dom);
  const opt = baseOption();
  opt.xAxis = { type: "category", data: o.date };
  opt.yAxis = { type: "value", scale: true,
    axisLabel: { formatter: v => (v * 100).toFixed(0) + "%" } };
  opt.dataZoom = [
    { type: "inside", xAxisIndex: 0 },
    { type: "slider", xAxisIndex: 0, bottom: 5, height: 16 },
  ];
  {
    const total = o.date.length;
    const st = Math.max(0, (1 - 500 / total) * 100);
    opt.dataZoom[0].start = st; opt.dataZoom[0].end = 100;
    opt.dataZoom[1].start = st; opt.dataZoom[1].end = 100;
  }
  opt.series = [{
    name: "活跃比例", type: "line", data: o.ratio, showSymbol: false,
    lineStyle: { width: 2, color: COLORS.amber },
    areaStyle: { color: "rgba(184,134,11,0.12)" },
    markLine: {
      silent: true, symbol: "none",
      data: [{ yAxis: 0.175, label: { formatter: "当前 17.5%" }, lineStyle: { color: "#999", type: "dashed" } }],
    },
  }];
  ch.setOption(opt);
  window.addEventListener("resize", () => ch.resize());
}

function renderWeekly() {
  const w = D.official_weekly;
  const ch = echarts.init(document.getElementById("chartWeekly"));
  const opt = baseOption();
  opt.legend = { top: 0, data: ["0AMV(左)", "活跃比例(右)"] };
  opt.xAxis = { type: "category", data: w.date, axisLabel: { interval: 250 } };
  opt.yAxis = [
    { type: "value", scale: true, name: "0AMV" },
    { type: "value", scale: true, name: "活跃比例", splitLine: { show: false },
      axisLabel: { formatter: v => (v * 100).toFixed(0) + "%" } },
  ];
  opt.series = [
    { name: "0AMV(左)", type: "line", data: w.amv, showSymbol: false,
      lineStyle: { width: 1.6, color: COLORS.official } },
    { name: "活跃比例(右)", type: "line", yAxisIndex: 1, data: w.ratio, showSymbol: false,
      lineStyle: { width: 1.4, color: COLORS.amber } },
  ];
  ch.setOption(opt);
  window.addEventListener("resize", () => ch.resize());
}

function onSectorClick(params) {
  if (params.componentType !== "series") return;
  if (VIEW_RANGE) showRangeSector(params.name);
  else showSectorStocks(params.name);
}

function setSecTab(tab) {
  SEC_TAB = tab;
  document.getElementById("tabInd").className = "modeBtn" + (tab === "industry" ? " active" : "");
  document.getElementById("tabConcept").className = "modeBtn" + (tab === "concept" ? " active" : "");
  document.getElementById("tabTdxStyle").className = "modeBtn" + (tab === "tdxstyle" ? " active" : "");
  document.getElementById("sectorChartTitle").textContent =
    tab === "industry" ? "板块活跃SZ贡献 Top 15（行业）" :
    tab === "concept" ? "概念板块活跃SZ Top 15（通达信）" :
    "风格板块活跃SZ Top 15（通达信）";
  renderSectors();
}

function renderSectors() {
  let secs;
  if (SEC_TAB === "concept" || SEC_TAB === "tdxstyle") {
    // 通达信概念/风格板块：按钮云全部展示，柱状图 Top 15
    const wantType = SEC_TAB === "concept" ? "概念" : "风格";
    const allBoards = (D.concept_boards || []).filter(b => b.type === wantType);
    renderConceptBtns(allBoards);
    secs = allBoards.slice(0, 15);
    const ch = echarts.init(document.getElementById("chartSectors"));
    const data = secs.slice().reverse();
    ch.setOption({
      grid: { left: 100, right: 80, top: 10, bottom: 30 },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
      yAxis: { type: "category", data: data.map(s => s.name) },
      series: [{
        type: "bar", data: data.map(s => s.amv_pct), barMaxWidth: 16,
        itemStyle: { color: COLORS.blue, borderRadius: [0, 4, 4, 0] },
        label: {
          show: true, position: "right", fontSize: 11,
          formatter: p => {
            const s = data[p.dataIndex];
            return p.value + "%" + (s.pick_n ? " 拐头" + s.pick_n : "");
          },
        },
      }],
    });
    ch.off("click");
    ch.on("click", p => showConceptStocks(p.name));
    window.addEventListener("resize", () => ch.resize());
    return;
  }
  if (SEC_TAB === "style") {
    secs = (D.styles || []).slice(0, 15);
    // 风格榜无成分映射，直接渲染按钮与柱状图，点击提示
    renderSectorBtnsStyle(secs);
    const ch = echarts.init(document.getElementById("chartSectors"));
    const data = secs.slice().reverse();
    ch.setOption({
      grid: { left: 90, right: 70, top: 10, bottom: 30 },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
      yAxis: { type: "category", data: data.map(s => s.name) },
      series: [{
        type: "bar", data: data.map(s => s.amount_pct), barMaxWidth: 16,
        itemStyle: { color: COLORS.blue, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", formatter: p => p.value + "%", fontSize: 11 },
      }],
    });
    ch.off("click");
    ch.on("click", () => {
      alert("风格板块暂无成分个股数据，仅展示风格层面的贡献占比。");
    });
    return;
  }
  const secsAmt = (D.sectors || []).filter(s => s.amount);
  if (MODE === "reg" || !secsAmt.length) {
    secs = (D.sectors_amv || []);
    renderSectorBtns(secs, false);
    secs = secs.slice(0, 15);
  } else {
    secs = secsAmt;
    renderSectorBtns(secs, false);
    secs = secs.slice(0, 15);
  }
  // 柱状图
  const secsRev = secs.slice().reverse();
  const ch = echarts.init(document.getElementById("chartSectors"));
  const opt = baseOption();
  opt.grid = { left: 90, right: 70, top: 10, bottom: 30 };
  opt.xAxis = { type: "value", axisLabel: { formatter: "{value}%" } };
  opt.yAxis = { type: "category", data: secsRev.map(s => s.name) };
  const valField = (MODE === "reg" || !(D.sectors || []).filter(s => s.amount).length) ? "amv_pct" : "amount_pct";
  opt.series = [{
    type: "bar", data: secsRev.map(s => s[valField]), barMaxWidth: 16,
    itemStyle: { color: COLORS.blue, borderRadius: [0, 4, 4, 0] },
    label: {
      show: true, position: "right", fontSize: 11,
      formatter: p => {
        const s = secsRev[p.dataIndex];
        const sc = s && s.score != null ? "  " + s.score.toFixed(0) + "分" : "";
        return p.value + "%" + sc;
      },
    },
  }];
  ch.setOption(opt);
  // 柱子点击同样生效
  ch.off("click");
  ch.on("click", onSectorClick);
  window.addEventListener("resize", () => ch.resize());
}

function renderConceptBtns(secs) {
  const btnBox = document.getElementById("sectorBtns");
  btnBox.innerHTML = "";
  secs.forEach(s => {
    const b = document.createElement("button");
    b.className = "sectorBtn";
    const pctTxt = s.pct == null ? "" : (s.pct >= 0 ? " ▲" : " ▼") + Math.abs(s.pct).toFixed(2) + "%";
    b.innerHTML = `${s.name} <span style="color:${s.pct >= 0 ? "#d64545" : "#2fa36b"};">${pctTxt}</span> ${s.amv_pct}%` + (s.pick_n ? `·拐${s.pick_n}` : "");
    b.onclick = () => showConceptStocks(s.name);
    btnBox.appendChild(b);
  });
}

function showConceptStocks(name) {
  const members = (D.concept_members || {})[name] || [];
  const codeSet = new Set(members);
  const amvList = (D.stocks_amv || []).filter(s => codeSet.has(s.code));
  const board = (D.concept_boards || []).find(b => b.name === name);
  const titleEl = document.getElementById("stockTableTitle");
  const noteEl = document.getElementById("stockTableNote");
  if (!amvList.length) {
    titleEl.textContent = `概念「${name}」成分股（数据采集中）`;
    noteEl.innerHTML = "该板块成分股活跃SZ数据暂未覆盖，明日自动更新后可见。";
    document.getElementById("stockTable").innerHTML = "";
    return;
  }
  const sorted = amvList.slice().sort((a, b) => (b.amv || 0) - (a.amv || 0));
  const total = sorted.reduce((t, s) => t + (s.amv || 0), 0) || 1;
  titleEl.textContent = `概念「${name}」成分个股 · 活跃SZ 排序（${sorted.length} 只全部展示）`;
  noteEl.innerHTML = `通达信板块代码 <b>${board ? board.code : "—"}</b>（可在通达信搜该代码看板块指数）· 成分 ${members.length} 只，已覆盖 ${sorted.length} 只 · 板块内今日拐头 ${board ? board.pick_n : "—"} 只。按个股活跃SZ排序。`;
  const fmt = (v, d = 1) =>
    v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  let html = `<table><thead><tr>
    <th>#</th><th>代码</th><th>名称</th><th>行业</th><th>涨跌幅</th><th>活跃SZ(亿)</th><th>板块内占比</th>
    <th>成交额(亿)</th><th>换手率</th></tr></thead><tbody>`;
  sorted.forEach((s, i) => {
    const pct = s.pct == null ? null : Number(s.pct);
    const pctCls = pct == null ? "" : (pct >= 0 ? "up" : "down");
    const pctTxt = pct == null ? "—" : (pct >= 0 ? "+" : "") + fmt(pct, 2) + "%";
    html += `<tr>
      <td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td>
      <td class="${pctCls}">${pctTxt}</td>
      <td>${fmt((s.amv || 0) / 1e8, 1)}</td>
      <td>${fmt((s.amv || 0) / total * 100, 2)}%</td>
      <td>${fmt((s.amount || 0) / 1e8, 1)}</td>
      <td>${fmt(s.turnover, 2)}%</td>
    </tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("stockTable").innerHTML = html;
}

function renderSectorBtnsStyle(secs) {
  const btnBox = document.getElementById("sectorBtns");
  btnBox.innerHTML = "";
  secs.forEach(s => {
    const b = document.createElement("button");
    b.className = "sectorBtn";
    b.textContent = `${s.name} ${s.amount_pct}%`;
    b.onclick = () => alert("风格板块暂无成分个股数据，仅展示风格层面的贡献占比。");
    btnBox.appendChild(b);
  });
}

function renderSectorBtns(secs, isRange) {
  const btnBox = document.getElementById("sectorBtns");
  btnBox.innerHTML = "";
  const useAmvPct = (MODE === "reg" || !(D.sectors || []).filter(s => s.amount).length);
  const pctField = (!isRange && useAmvPct) ? "amv_pct" : "amount_pct";
  secs.forEach(s => {
    const b = document.createElement("button");
    b.className = "sectorBtn";
    const sc = s.score != null ? " · " + s.score.toFixed(0) + "分" : "";
    const chg = s.amv_chg != null
      ? (s.amv_chg >= 0 ? " ▲" : " ▼") + Math.abs(s.amv_chg).toFixed(1) + "%"
      : "";
    b.textContent = `${s.name} ${s[pctField] ?? s.amount_pct}%${chg}${sc}`;
    b.onclick = () => {
      CURRENT_SECTOR = s.name;
      document.getElementById("backBtn2").style.display = "inline-block";
      document.querySelectorAll(".sectorBtn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      if (isRange) {
        showRangeSector(s.name);
      } else {
        showSectorStocks(s.name);
      }
    };
    btnBox.appendChild(b);
  });
}

function setMode(mode) {
  MODE = mode;
  ["btnAmt", "btnReg"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = "modeBtn" + (id === "btn" + mode.charAt(0).toUpperCase() + mode.slice(1) ? " active" : "");
  });
  if (VIEW_RANGE) {
    renderRangeStocks(VIEW_RANGE[0], VIEW_RANGE[1]);
    return;
  }
  renderSectors();
  if (CURRENT_SECTOR) {
    showSectorStocks(CURRENT_SECTOR);
  } else {
    showMarketStocks();
  }
}

function showSectorStocks(sectorName) {
  CURRENT_SECTOR = sectorName;
  const backBtn = document.getElementById("backBtn2");
  backBtn.style.display = "inline-block";
  backBtn.textContent = "← 返回全市场排名";
  backBtn.onclick = showMarketStocks;
  const codes = (D.sector_members || {})[sectorName];
  let rows;
  if (codes && codes.length) {
    const codeSet = new Set(codes);
    rows = (D.all_stocks || [])
      .filter(s => codeSet.has(s.code) && s.amount)
      .sort((a, b) => b.amount - a.amount);
  } else {
    rows = (D.all_stocks || [])
      .filter(s => s.industry === sectorName && s.amount)
      .sort((a, b) => b.amount - a.amount);
  }
  if (MODE === "reg") {
    const list = D.stocks_amv || [];
    const field = "amv";
    const pctField = "amv_pct";
    if (!list.length) {
      document.getElementById("stockTableTitle").textContent =
        "活跃SZ（逐股递推）数据采集中";
      document.getElementById("stockTableNote").innerHTML =
        "每日自动补充。";
      document.getElementById("stockTable").innerHTML = "";
      return;
    }
    const amvMap = new Map(list.map(s => [s.code, s]));
    rows = rows
      .map(s => {
        const d = amvMap.get(s.code);
        if (!d) return s;
        const o = { ...s };
        o[field] = d[field];
        o[pctField] = d[pctField];
        return o;
      })
      .sort((a, b) => (b[field] || 0) - (a[field] || 0));
  } else {
    rows = rows;
  }
  document.getElementById("stockTableTitle").textContent =
    `板块「${sectorName}」成分个股贡献 Top ${rows.length}` +
    (MODE === "reg" ? "（活跃SZ递推口径）" : "");
  document.getElementById("stockTableNote").innerHTML =
    (MODE === "reg"
      ? `递推活跃度 A_t = 0.9169×A_t-1 + min(换手率/1.1,1)×(1−A_t-1)；活跃SZ = 流通市值 × A；占比 = 个股活跃SZ / 已覆盖个股活跃SZ合计。逐股加总与官方 0AMV 相关系数 0.9983。`
      : `按成交额排序；占比 = 个股成交额 / 全市场成交额。`);
  renderStockRows(rows);
}

function showMarketStocks() {
  CURRENT_SECTOR = null;
  VIEW_RANGE = null;
  document.getElementById("backBtn2").style.display = "none";
  document.querySelectorAll(".sectorBtn").forEach(x => x.classList.remove("active"));
  if (MODE === "reg") {
    const regList = D.stocks_amv || [];
    if (!regList.length) {
      document.getElementById("stockTableTitle").textContent =
        "活跃SZ（逐股递推）数据采集中";
      document.getElementById("stockTableNote").innerHTML =
        "递推活跃度 A_t = D×A_t-1 + min(换手率/1.1,1)×(1−A_t-1)，D=0.5^(1.25/10)；活跃SZ = 流通市值 × A。每日自动补充。";
      document.getElementById("stockTable").innerHTML = "";
      return;
    }
    document.getElementById("stockTableTitle").textContent =
      `个股活跃SZ贡献 Top ${regList.length}（逐股递推·实测）`;
    document.getElementById("stockTableNote").innerHTML =
      `递推活跃度（半衰期10天/激活率=换手率÷1.1），活跃SZ = 流通市值 × 活跃度；逐股加总与官方 0AMV 相关 0.9983、2021+ 误差 1.8%。占比 = 个股活跃SZ / 已覆盖个股活跃SZ合计。`;
    renderStockRows(regList);
    return;
  }
  document.getElementById("stockTableTitle").textContent =
    "个股活跃市值贡献 Top 50（全市场）";
  document.getElementById("stockTableNote").innerHTML =
    "按当日成交额排序；占比 = 个股成交额 / 全市场成交额。";
  renderStockRows((D.stocks_top || []));
}

function filterSectorBtns() {
  const kw = (document.getElementById("sectorSearch") || {}).value || "";
  const btns = document.querySelectorAll("#sectorBtns .sectorBtn");
  btns.forEach(b => {
    b.style.display = (!kw || b.textContent.includes(kw)) ? "" : "none";
  });
}

function renderNews() {
  // 优先腾讯云 COS（amv-news 云函数每小时写），失败回退 Pages 的 news.json 与主数据日更快讯
  fetch("https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com/news.json?t=" + new Date().getTime())
    .then(r => r.json())
    .then(j => renderNewsList(j.news || [], j.updated_at || ""))
    .catch(() => {
      fetch("news.json?v=" + new Date().getTime())
        .then(r => r.json())
        .then(j => renderNewsList(j.news || [], j.updated_at || ""))
        .catch(() => renderNewsList(D.news || [], ""));
    });
}

function renderNewsList(news, updatedAt) {
  const el = document.getElementById("newsList");
  if (!el) return;
  if (!news.length) {
    el.innerHTML = "<p style='color:var(--muted);'>快讯抓取中，稍后刷新。</p>";
    return;
  }
  const t = document.getElementById("newsTime");
  if (t) t.textContent = "更新 " + (updatedAt || news[0].time || "");
  loadGoodNews();
  const GOOD = ["利好", "获批", "中标", "预增", "超预期", "回购", "增持", "涨价", "创新高", "签约", "净流入", "降息", "降温", "提振", "上调", "回暖", "强劲", "突破", "加速", "翻红", "大涨", "新高"];
  const BAD = ["利空", "处罚", "立案", "亏损", "下滑", "减持", "退市", "违规", "爆雷", "下调", "净流出", "加息", "升温", "萎缩", "疲软", "大跌", "暴跌", "违约"];
  let html = "<div style='max-height:420px;overflow-y:auto;'>";
  news.forEach(n => {
    let txt = n.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let cls = "";
    if (GOOD.some(k => txt.includes(k))) cls = "good";
    else if (BAD.some(k => txt.includes(k))) cls = "bad";
    html += `<div class="newsItem ${cls}" style="padding:4px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span style="color:var(--muted);margin-right:8px;">${n.time || ""}</span>${txt}
    </div>`;
  });
  html += "</div>";
  el.innerHTML = html;
}

function loadGoodNews() {
  const box = document.getElementById("goodNewsBox");
  if (!box) return;
  // 优先 COS（amv-news 每小时写），失败回退 Pages
  const render = j => {
    const items = j.items || [];
    if (!items.length) {
      box.innerHTML = "<div style='font-size:12.5px;color:var(--muted);padding:6px 0;'>📌 今日利好速览：暂无可收录的利好消息。</div>";
      return;
    }
    let html = `<div style="border:1px solid var(--soft-red-bd);background:var(--soft-red);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
      <b style="font-size:13px;">📌 今日利好速览（${j.date || ""}，${items.length} 条）</b>
      <div style="max-height:220px;overflow-y:auto;margin-top:4px;">`;
    items.slice(0, 250).forEach(n => {
      html += `<div style="padding:2px 0;font-size:12.5px;">
        <span style="color:var(--muted);">${(n.time || "").slice(11)}</span> ${(n.text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}` +
        (n.category ? ` <span style="font-size:11px;color:#3b6fe0;background:var(--soft);border-radius:3px;padding:0 5px;">${n.category}</span>` : "") +
        `</div>`;
    });
    html += "</div></div>";
    box.innerHTML = html;
  };
  fetch("https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com/good_news.json?t=" + new Date().getTime())
    .then(r => r.json())
    .then(render)
    .catch(() => fetch("good_news.json?v=" + new Date().getTime())
      .then(r => r.json())
      .then(render)
      .catch(() => {}));
}

function renderStocks() {
  showMarketStocks();
  renderPicks();
  renderNews();
  renderSignals();
}

function renderSignals() {
  const sa = D.stocks_amv || [];
  const upEl = document.getElementById("sigUpList");
  const downEl = document.getElementById("sigDownList");
  if (!upEl || !downEl) return;
  const ups = sa.filter(s => s.cross === "up").sort((a, b) => (b.gap || 0) - (a.gap || 0));
  const downs = sa.filter(s => s.cross === "down").sort((a, b) => (a.gap || 0) - (b.gap || 0));
  const rowHtml = s => `<tr><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td>
    <td class="${(s.gap || 0) >= 0 ? "up" : "down"}">${(s.gap || 0) >= 0 ? "+" : ""}${s.gap}%</td>
    <td>${s.pctile != null ? s.pctile + "%" : "—"}</td>
    <td>${s.turnover != null ? s.turnover.toFixed(2) + "%" : "—"}</td></tr>`;
  upEl.innerHTML = `<table><thead><tr><th>代码</th><th>名称</th><th>行业</th><th>MA10偏离</th><th>250日分位</th><th>换手</th></tr></thead><tbody>`
    + ups.slice(0, 80).map(rowHtml).join("") + "</tbody></table>";
  downEl.innerHTML = `<table><thead><tr><th>代码</th><th>名称</th><th>行业</th><th>MA10偏离</th><th>250日分位</th><th>换手</th></tr></thead><tbody>`
    + downs.slice(0, 80).map(rowHtml).join("") + "</tbody></table>";
}

function showSignal() {
  const kw = (document.getElementById("sigSearch") || {}).value || "";
  const el = document.getElementById("sigResult");
  if (!el) return;
  if (!kw) {
    el.innerHTML = "";
    return;
  }
  const sa = D.stocks_amv || [];
  const s = sa.find(x => x.code === kw || x.name === kw || x.code.slice(2) === kw);
  if (!s) {
    el.innerHTML = "<span style='color:#c0392b;'>未找到该股（或递推数据未覆盖）</span>";
    return;
  }
  const gap = s.gap != null ? s.gap : 0;
  const crossTxt = s.cross === "up" ? "🔼 拐头向上（激活）" : s.cross === "down" ? "🔽 拐头向下（降温）" : "➡ 均线附近（保持）";
  const gapCls = gap >= 0 ? "up" : "down";
  el.innerHTML =
    `<b>${s.code} ${s.name}</b>（${s.industry || "—"}） ` +
    `活跃SZ <b>${(s.amv / 1e8).toFixed(1)}</b>亿 ｜ MA10 <b>${(s.ma10 / 1e8).toFixed(1)}</b>亿 ｜ ` +
    `偏离 <span class="${gapCls}"><b>${gap >= 0 ? "+" : ""}${gap}%</b></span> ｜ ` +
    `250日分位 <b>${s.pctile != null ? s.pctile + "%" : "—"}</b> ｜ ${crossTxt} ｜ ` +
    `换手 ${s.turnover != null ? s.turnover.toFixed(2) + "%" : "—"} ｜ 涨跌 ${s.pct != null ? (s.pct >= 0 ? "+" : "") + s.pct.toFixed(2) + "%" : "—"}`;
}

function renderPicks() {
  const picks = D.picks || [];
  const hist = D.picks_history || {};
  const el = document.getElementById("pickTable");
  if (!el) return;
  // 日期下拉：当日 + 历史（倒序）
  const sel = document.getElementById("pickDateSel");
  if (sel && sel.options.length === 0) {
    const histDates = Object.keys(hist).sort().reverse();
    const latestDate = picks.length ? picks[0].date : (histDates[0] || "");
    const allDates = histDates.includes(latestDate) ? histDates : [latestDate, ...histDates];
    allDates.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d + (d === latestDate ? "（最新）" : "");
      sel.appendChild(opt);
    });
  }
  const selDate = sel ? sel.value : "";
  let list;
  let isHistory = false;
  if (selDate && hist[selDate] && selDate !== (picks[0] || {}).date) {
    list = hist[selDate];
    isHistory = true;
  } else {
    list = picks;
  }
  if (!list.length) {
    el.innerHTML = "<p style='color:var(--muted);'>该日暂无拐头信号（活跃度均线以下运行或数据未更新）。</p>";
    return;
  }
  // 板块筛选下拉（每次重建，保留选择）
  const indSel = document.getElementById("pickIndSel");
  if (indSel) {
    const curVal = indSel.value;
    const inds = [...new Set(list.map(s => s.industry || "—"))].sort();
    indSel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "全部板块";
    indSel.appendChild(allOpt);
    inds.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      indSel.appendChild(opt);
    });
    if (inds.includes(curVal)) indSel.value = curVal;
  }
  // 板块筛选
  const indFilter = indSel ? indSel.value : "";
  let filtered = indFilter ? list.filter(s => (s.industry || "—") === indFilter) : list;
  // 排序
  const sortSel = document.getElementById("pickSortSel");
  const sortKey = sortSel ? sortSel.value : "amv";
  const sortKeys = { amv: "amv", gap: "gap", up: "up_days", amount: "amount" };
  const k = sortKeys[sortKey] || "amv";
  filtered = filtered.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0));
  const fmt = (v, d = 1) =>
    v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  const top = filtered; // 全部展示
  const lastDate = top.length ? top[0].date : (list[0] || {}).date;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const stale = lastDate < todayStr;
  const infoEl = document.getElementById("pickDateInfo");
  if (infoEl) {
    infoEl.textContent = (indFilter ? "板块「" + indFilter + "」" : "全板块") +
      "，" + filtered.length + " / " + list.length + " 只" +
      (isHistory ? "（历史仅存每日 top 30）" : "");
  }
  document.getElementById("pickNote").innerHTML =
    `选股日 <b>${lastDate}</b>` +
    (stale && !isHistory ? ` <span style="color:#c0392b;">（非最新交易日，云端数据待更新）</span>` : "") +
    `：活跃度 A 上穿自身 10 日均线（昨日在均线下、今日站上），捕捉资金重新激活。`;
  let html = `<table><thead><tr>
    <th>#</th><th>代码</th><th>名称</th><th>板块</th><th>活跃度A</th><th>10日均线</th>
    <th>上穿幅度</th><th>活跃SZ(亿)</th><th>当日成交额(亿)</th><th>连续上升</th></tr></thead><tbody>`;
  top.forEach((s, i) => {
    const aPct = s.A != null ? (s.A * 100).toFixed(1) + "%" : "—";
    const maPct = s.ma != null ? (s.ma * 100).toFixed(1) + "%" : "—";
    const gapCls = (s.gap || 0) >= 2 ? "up" : "";
    html += `<tr>
      <td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td>
      <td>${aPct}</td><td>${maPct}</td>
      <td class="${gapCls}">${s.gap != null ? "+" + fmt(s.gap, 2) + "%" : "—"}</td>
      <td>${fmt((s.amv || 0) / 1e8, 1)}</td>
      <td>${fmt((s.amount || 0) / 1e8, 1)}</td>
      <td>${s.up_days ?? "—"} 天</td>
    </tr>`;
  });
  html += "</tbody></table>";
  el.innerHTML = html;
}

function onPickDateChange() {
  renderPicks();
}

function renderStockRows(rows) {
  const fmt = (v, d = 1) =>
    v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  const isAmv = MODE === "reg";
  const amvField = "amv";
  const amvPctField = "amv_pct";
  const scoreCell = s => {
    if (s.score == null) return "—";
    const sc = Number(s.score);
    const color = sc >= 70 ? "#d64545" : sc >= 50 ? "#b8860b" : "#2fa36b";
    return `<span style="color:${color};font-weight:700;">${sc.toFixed(0)}</span>`;
  };
  let html = `<table><thead><tr>
    <th>#</th><th>代码</th><th>名称</th><th>行业</th><th>评分</th>` +
    (isAmv ? `<th>活跃市值(亿)</th><th>占比</th>` : "") +
    `<th>活跃SZ(亿)</th><th>流通市值(亿)</th><th>换手率</th><th>涨跌幅</th></tr></thead><tbody>`;
  rows.forEach((s, i) => {
    const pct = s.pct == null ? null : Number(s.pct);
    const pctCls = pct == null ? "" : (pct >= 0 ? "up" : "down");
    const pctTxt = pct == null ? "—" : (pct >= 0 ? "+" : "") + fmt(pct, 2) + "%";
    const amvVal = s[amvField];
    const amvTxt = amvVal ? fmt(amvVal / 1e8, 0) : "—";
    const amvPctTxt = s[amvPctField] != null ? fmt(s[amvPctField], 2) + "%" : "—";
    html += `<tr>
      <td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td>` +
      `<td>${scoreCell(s)}</td>` +
      (isAmv ? `<td>${amvTxt}</td><td>${amvPctTxt}</td>` : "") +
      `<td>${fmt(s.amount / 1e8, 1)}</td>` +
      `<td>${fmt(s.float_mv / 1e8, 0)}</td><td>${fmt(s.turnover, 2)}%</td>` +
      `<td class="${pctCls}">${pctTxt}</td>
    </tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("stockTable").innerHTML = html;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function renderSummary() {
  const el = document.getElementById("summaryBox");
  if (!el) return;
  el.innerHTML = "<span style='color:var(--muted);'>加载中…</span>";
  const load = url => fetch(url).then(r => r.json());
  load("https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com/summary.json?t=" + new Date().getTime())
    .then(j => {
      if (j && j.text) {
        el.innerHTML = `<div>${esc(j.text)}</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">${esc(j.date || "")} ${esc(j.updated_at || "")}</div>`;
      } else {
        el.innerHTML = "<span style='color:var(--muted);'>今日总结生成中（收盘后自动更新）。</span>";
      }
    })
    .catch(() => {
      load("summary.json?v=" + new Date().getTime())
        .then(j => {
          if (j && j.text) {
            el.innerHTML = `<div>${esc(j.text)}</div><div style="font-size:11px;color:var(--muted);margin-top:4px;">${esc(j.date || "")}</div>`;
          } else {
            el.innerHTML = "<span style='color:var(--muted);'>今日总结生成中（收盘后自动更新）。</span>";
          }
        })
        .catch(() => { el.innerHTML = "<span style='color:var(--muted);'>今日总结生成中（收盘后自动更新）。</span>"; });
    });
}

function renderSources() {
  const el = document.getElementById("srcBox");
  if (!el) return;
  const rows = [];
  const add = (name, ok, timeTxt) => {
    rows.push(`<span style="display:inline-block;border:1px solid ${ok ? "var(--soft-green-bd)" : "var(--soft-red-bd)"};background:${ok ? "var(--soft-green)" : "var(--soft-red)"};border-radius:4px;padding:3px 10px;margin:3px;font-size:12px;">${ok ? "✅" : "⚠️"} ${name}：${timeTxt}</span>`);
    el.innerHTML = rows.join("");
  };
  if (D) {
    add("主数据（云端重算）", true, D.updated_at || "—");
    const off = D.official || {};
    if (off.date && off.date.length) add("官方0AMV序列", true, "最新 " + off.date[off.date.length - 1]);
    add("通达信口径（本地同步）", true, D.official_source || "—");
  }
  el.innerHTML = rows.join("") || "<span style='color:var(--muted);'>加载中…</span>";
  fetch("https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com/news.json?t=" + new Date().getTime())
    .then(r => r.json())
    .then(j => add("快讯（新浪+东财+金十）", true, j.updated_at || "—"))
    .catch(() => add("快讯（新浪+东财+金十）", false, "读取失败"));
  fetch("https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com/live_data.json?t=" + new Date().getTime())
    .then(r => r.json())
    .then(j => add("实盘数据（腾讯云）", true, j.updated_at || "—"))
    .catch(() => add("实盘数据（腾讯云）", false, "连接失败"));
}

function renderAll() {
  renderSummary();
  renderSources();
  renderBullBear();
  renderAboutToCross();
  renderMeta();
  renderMain();
  renderTrio();
  renderRatio();
  renderWeekly();
  renderSectors();
  renderStocks();
}

let BB_DATA = null;

function renderAboutToCross() {
  const el = document.getElementById("aboutCrossBox");
  if (!el) return;
  const list = (D && D.about_to_cross) || [];
  if (!list.length) {
    el.innerHTML = "<span style='color:var(--muted);'>今日暂无快上穿候选（活跃SZ 接近 MA10 的股票）。</span>";
    return;
  }
  let html = `<table><thead><tr><th>代码</th><th>名称</th><th>现价</th><th>涨跌</th><th>活跃度A</th><th>MA10</th><th>距上穿</th><th>预计</th></tr></thead><tbody>`;
  list.forEach(x => {
    const p = x.pct != null ? (x.pct > 0 ? "+" : "") + Number(x.pct).toFixed(2) + "%" : "—";
    const price = x.price != null ? Number(x.price).toFixed(2) : "—";
    const cls = x.pct != null && x.pct >= 0 ? "up" : "down";
    html += `<tr><td>${x.code}</td><td>${x.name}</td><td>${price}</td>
      <td class="${cls}">${p}</td>
      <td>${Number(x.a).toFixed(3)}</td><td>${Number(x.ma10).toFixed(3)}</td>
      <td style="color:#c0392b;"><b>${x.gap_pct}%</b></td><td>${x.days}天</td></tr>`;
  });
  html += "</tbody></table>";
  el.innerHTML = html;
}

function renderBullBear() {
  const el = document.getElementById("bullBearBox");
  if (!el) return;
  if (!BB_DATA) {
    el.innerHTML = "<span style='color:var(--muted);'>牛熊评分计算中…</span>";
    return;
  }
  renderBullBearBox(el, BB_DATA);
}

function loadBullBear() {
  fetch("bull_bear.json?v=" + new Date().getTime())
    .then(r => r.json())
    .then(j => {
      if (j && j.scores) {
        BB_DATA = j;
        const el = document.getElementById("bullBearBox");
        if (el) renderBullBearBox(el, j);
      }
    })
    .catch(() => {
      // 独立 json 拉不到时，才用主数据里的牛熊（避免永久“计算中”）
      if (D && D.bull_bear && D.bull_bear.scores) {
        const el = document.getElementById("bullBearBox");
        if (el) renderBullBearBox(el, D.bull_bear);
      }
    });
}

function renderBullBearBox(el, bb) {
  const s = bb.scores;
  const total = bb.total;
  const mods = [
    ["价格趋势", s.trend, "25%"],
    ["市场广度", s.breadth, "20%"],
    ["成交量能", s.volume, "15%"],
    ["宏观盈利", s.macro, "15%"],
    ["市场估值", s.valuation, "10%"],
    ["情绪杠杆", s.sentiment, "15%"],
  ];
  const bar = v => {
    const p = Math.max(0, Math.min(100, (v + 100) / 2));
    const c = v >= 20 ? "#2fa36b" : v <= -20 ? "#d64545" : "#b8860b";
    return `<div style="height:8px;background:var(--border);border-radius:4px;margin:2px 0;"><div style="width:${p}%;height:8px;background:${c};border-radius:4px;"></div></div>`;
  };
  let html = `<div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start;">
    <div style="min-width:150px;text-align:center;">
      <div style="font-size:38px;font-weight:800;color:${total >= 15 ? "#d64545" : total <= -15 ? "#2fa36b" : "var(--muted)"};">${total > 0 ? "+" : ""}${total}</div>
      <div style="font-size:14px;font-weight:600;">${bb.state}</div>
      <div style="font-size:11px;color:var(--muted);">更新 ${bb.updated_at || ""}${bb.trade_date ? " ｜ 最新交易日 " + bb.trade_date : ""}</div>
    </div>
    <div style="flex:1;min-width:320px;">`;
  mods.forEach(([name, v, w]) => {
    const vv = v != null ? v : 0;
    html += `<div style="font-size:12px;">${name}（${w}）<span style="float:right;font-weight:600;" class="${vv >= 15 ? "up" : vv <= -15 ? "down" : "flat"}">${vv > 0 ? "+" : ""}${vv}</span>${bar(vv)}</div>`;
  });
  html += "</div></div>";
  // 明细
  const d = bb.details || {};
  if (d.volume && d.volume.cur_yi) {
    html += `<div style="font-size:11.5px;color:var(--muted);margin-top:6px;">量能：今日成交 ${d.volume.cur_yi}亿（20日均 ${d.volume.ma20_yi}亿，比值 ${d.volume.ratio20}）｜广度：站上60日线 ${d.breadth.above_pct ? d.breadth.above_pct[60] : "—"}%、250日线 ${d.breadth.above_pct ? d.breadth.above_pct[250] : "—"}%｜情绪：上涨占比 ${d.sentiment.up_ratio}%、涨停 ${d.sentiment.limit_up}、最高 ${d.sentiment.max_board} 板</div>`;
  }
  if (d.macro_note) {
    html += `<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">📋 宏观/估值（手动维护，截止 ${d.macro_asof || "—"}）：${d.macro_note}</div>`;
  }
  html += `<div id="bbHistBox" style="margin-top:6px;"><span style="font-size:11px;color:var(--muted);">历史趋势分数加载中…</span></div>`;
  el.innerHTML = html;
  loadBBHistory();
}

function loadBBHistory() {
  const box = document.getElementById("bbHistBox");
  if (!box) return;
  fetch("bb_history.json?v=" + new Date().getTime())
    .then(r => r.json())
    .then(j => {
      const h = j.history || [];
      if (!h.length) {
        box.innerHTML = "";
        return;
      }
      const W = 660, H = 140, PL = 40, PR = 8, PT = 8, PB = 18;
      const iw = W - PL - PR, ih = H - PT - PB;
      const x = i => PL + (i / (h.length - 1)) * iw;
      const y = v => PT + (1 - (v + 100) / 200) * ih;
      let d = "";
      h.forEach((p, i) => { d += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.score).toFixed(1); });
      let labels = "";
      h.forEach((p, i) => {
        if (i % 200 === 0 || i === h.length - 1) {
          labels += `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-size="9" fill="var(--muted)" text-anchor="middle">${p.date.slice(0, 4)}</text>`;
        }
      });
      box.innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="background:var(--card2);border:1px solid var(--border);border-radius:6px;">
        <line x1="${PL}" y1="${y(35)}" x2="${W - PR}" y2="${y(35)}" stroke="#e0c9c9" stroke-width="1" stroke-dasharray="3,3"/>
        <line x1="${PL}" y1="${y(-35)}" x2="${W - PR}" y2="${y(-35)}" stroke="#c9e0cf" stroke-width="1" stroke-dasharray="3,3"/>
        <line x1="${PL}" y1="${y(0)}" x2="${W - PR}" y2="${y(0)}" stroke="var(--border)" stroke-width="1"/>
        <path d="${d}" fill="none" stroke="#3b6fe0" stroke-width="1.4"/>
        <text x="${PL - 4}" y="${y(35) + 3}" font-size="9" fill="#c0392b" text-anchor="end">+35</text>
        <text x="${PL - 4}" y="${y(-35) + 3}" font-size="9" fill="#2fa36b" text-anchor="end">-35</text>
        ${labels}
        <text x="${PL}" y="10" font-size="9" fill="var(--muted)">牛熊趋势分数回测（仅趋势模块·官方0AMV vs 均线，约5年）</text>
      </svg>`;
    })
    .catch(() => { if (box) box.innerHTML = ""; });
}

async function fetchDataGz() {
  // 拉 gzip 版数据；失败返回 null
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const r = await fetch("app-data.js.gz?v=" + new Date().getTime());
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    const txt = await new Response(stream).text();
    return JSON.parse(txt.slice(txt.indexOf("{")).replace(/;\s*$/, ""));
  } catch (e) {
    return null;
  }
}

function loadDataScript(onload, onerror) {
  const ts = new Date().getTime();
  const script = document.createElement("script");
  script.src = "app-data.js?v=" + ts;
  script.onload = onload;
  script.onerror = onerror;
  document.body.appendChild(script);
}

function refreshAll() {
  const btn = document.getElementById("btnRefresh");
  const msg = document.getElementById("refreshMsg");
  if (msg) {
    msg.innerHTML = "⏳ 正在重新拉取最新数据…";
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ 刷新中…";
  }
  const done = () => {
    renderAll();
    if (msg) {
      msg.innerHTML = "✅ 已刷新（更新时间：" + (D.updated_at || "—") + "）";
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔄 立即刷新";
    }
    queryCloudStatus(msg);
  };
  const fail = () => {
    if (msg) msg.innerHTML = "❌ 刷新失败，请稍后重试或按 Ctrl+F5 强制刷新。";
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔄 立即刷新";
    }
  };
  fetchDataGz().then(d => {
    if (d) {
      D = d;
      done();
    } else {
      loadDataScript(() => { D = window.DATA; done(); }, fail);
    }
  }).catch(() => loadDataScript(() => { D = window.DATA; done(); }, fail));
}

function autoRefreshData() {
  // 静默自动刷新：每 10 分钟拉最新数据重渲染（板块/个股/选股）
  loadBullBear();  // 牛熊数据同步刷新（时间戳跟着变）
  fetchDataGz().then(d => {
    if (d) {
      D = d;
      renderAll();
    } else {
      loadDataScript(() => {
        if (window.DATA) {
          D = window.DATA;
          renderAll();
        }
      }, () => {});
    }
  }).catch(() => {});
}

function autoRefreshNews() {
  // 与 renderNews 同源：优先 COS（最新），失败回退 Pages
  fetch("https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com/news.json?t=" + new Date().getTime())
    .then(r => r.json())
    .then(j => {
      if (j && j.news) {
        renderNewsList(j.news, j.updated_at || "");
      }
    })
    .catch(() => {
      fetch("news.json?v=" + new Date().getTime())
        .then(r => r.json())
        .then(j => {
          if (j && j.news) {
            renderNewsList(j.news, j.updated_at || "");
          }
        })
        .catch(() => {});
    });
}

function queryCloudStatus(msg) {
  fetch("https://api.github.com/repos/pulsiferkelley87-a11y/amv-site/actions/runs?per_page=3")
    .then(r => r.json())
    .then(j => {
      const runs = j.workflow_runs || [];
      const latest = runs[0];
      if (latest && msg) {
        const st = latest.status === "completed"
          ? (latest.conclusion === "success" ? "✓ 成功" : "✗ 失败")
          : "⏳ 运行中";
        msg.innerHTML += " ｜ 云端自动更新：" + st + "（" + (latest.created_at || "").replace("T", " ").slice(0, 16) + " UTC）";
      }
    })
    .catch(() => {});
}

function toggleDrop() {
  SHOW_DROP = !SHOW_DROP;
  const btn = document.getElementById("btnDrop");
  if (btn) btn.textContent = SHOW_DROP ? "−2.3%标记：开" : "−2.3%标记：关";
  renderMain();
}

function line(data, name, color, width) {
  return {
    name, type: "line", data, showSymbol: false,
    lineStyle: { width, color }, itemStyle: { color },
  };
}

load();
loadBullBear();  // 牛熊卡片独立立即加载（2KB 小文件，不等主数据）
window.refreshCharts = renderAll;  // 主题切换后重绘图表（新配色）

// 自动刷新：数据每 10 分钟、快讯每 5 分钟（静默，无需手动操作）
setInterval(autoRefreshData, 600000);
setInterval(autoRefreshNews, 300000);
