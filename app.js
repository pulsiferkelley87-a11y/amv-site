// amv-site 前端逻辑
const COLORS = {
  official: "#d64545",
  var1: "#9aa3af",
  c5: "#3b6fe0",
  c13: "#2fa36b",
  c34: "#b8860b",
  cinf: "#7c5cbf",
  amv_hat: "#e07b3b",
  znz0: "#3b6fe0",
  dmv: "#9aa3af",
};

let D = null;
let mainLegendInit = false; // 官方 0AMV 图例开关只在首次初始化时设置，重绘时保持用户选择
let MODE = "amt";        // amt = 成交额口径, reg = 公式口径, dma = 流传DMA版
let CURRENT_SECTOR = null; // null = 全市场
let VIEW_RANGE = null;     // null = 最新；否则 [start, end]
let RANGE_SORT = "amount"; // amount = 区间累计成交额；drag = 拖后腿榜（活跃市值变化升序）
let SEC_TAB = "industry"; // industry = 行业榜；style = 风格榜
let SHOW_DROP = true;    // −2.3% 事件标记开关

async function load() {
  D = window.DATA;
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
    `数据更新：${D.updated_at} ｜ 官方序列来源：${src} ｜ 最新交易日 ${o.date[last]} ` +
    `0AMV <b>${amv.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}</b> ` +
    `(<span class="${cls}">${chg >= 0 ? "+" : ""}${chg}%</span>) ` +
    `活跃比例 <b>${(r * 100).toFixed(2)}%</b> ` +
    (D.market_totals
      ? `｜ 全市场成交额 ${(D.market_totals.amount / 1e12).toFixed(2)} 万亿`
      : "") +
    (D.errors.length ? ` ｜ <span class="down">${D.errors.join("；")}</span>` : "");
}

function baseOption() {
  return {
    animation: false,
    grid: { left: 55, right: 55, top: 40, bottom: 40 },
    tooltip: { trigger: "axis", backgroundColor: "#fff", borderColor: "#e5e7eb",
               textStyle: { color: "#1a1d24", fontSize: 12 } },
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
  document.getElementById("tabStyle").className = "modeBtn" + (tab === "style" ? " active" : "");
  document.getElementById("sectorChartTitle").textContent =
    tab === "industry" ? "板块活跃SZ贡献 Top 15" : "风格贡献 Top 15（版本陷阱识别）";
  renderSectors();
}

function renderSectors() {
  let secs;
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
  secs = (MODE === "reg"
    ? (D.sectors_amv || [])
    : (D.sectors || []).filter(s => s.amount)
  ).slice(0, 15);
  renderSectorBtns(secs, false);
  // 柱状图
  const secsRev = secs.slice().reverse();
  const ch = echarts.init(document.getElementById("chartSectors"));
  const opt = baseOption();
  opt.grid = { left: 90, right: 70, top: 10, bottom: 30 };
  opt.xAxis = { type: "value", axisLabel: { formatter: "{value}%" } };
  opt.yAxis = { type: "category", data: secsRev.map(s => s.name) };
  const valField = MODE === "reg" ? "amv_pct" : "amount_pct";
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
  const pctField = (!isRange && MODE === "reg") ? "amv_pct" : "amount_pct";
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
      .sort((a, b) => (b[field] || 0) - (a[field] || 0))
      .slice(0, 50);
  } else {
    rows = rows.slice(0, 50);
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
    renderStockRows(regList.slice(0, 50));
    return;
  }
  document.getElementById("stockTableTitle").textContent =
    "个股活跃市值贡献 Top 50（全市场）";
  document.getElementById("stockTableNote").innerHTML =
    "按当日成交额排序；占比 = 个股成交额 / 全市场成交额。";
  renderStockRows((D.stocks_top || []).slice(0, 50));
}

function renderStocks() {
  showMarketStocks();
  renderPicks();
}

function renderPicks() {
  const picks = D.picks || [];
  const el = document.getElementById("pickTable");
  if (!el) return;
  if (!picks.length) {
    el.innerHTML = "<p style='color:var(--muted);'>今日暂无拐头信号（活跃度均线以下运行或数据未更新）。</p>";
    return;
  }
  const fmt = (v, d = 1) =>
    v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  const top = picks.slice(0, 60);
  const lastDate = top[0].date || "";
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const stale = lastDate < todayStr;
  document.getElementById("pickNote").innerHTML =
    `选股日 <b>${lastDate}</b>` +
    (stale ? ` <span style="color:#c0392b;">（非最新交易日，云端数据待更新）</span>` : "") +
    `：活跃度 A 上穿自身 10 日均线（昨日在均线下、今日站上），捕捉资金重新激活。共 <b>${picks.length}</b> 只，按活跃SZ从大到小排列（展示前 ${top.length}）。`;
  let html = `<table><thead><tr>
    <th>#</th><th>代码</th><th>名称</th><th>活跃度A</th><th>10日均线</th>
    <th>上穿幅度</th><th>活跃SZ(亿)</th><th>当日成交额(亿)</th><th>连续上升</th></tr></thead><tbody>`;
  top.forEach((s, i) => {
    const aPct = s.A != null ? (s.A * 100).toFixed(1) + "%" : "—";
    const maPct = s.ma != null ? (s.ma * 100).toFixed(1) + "%" : "—";
    const gapCls = (s.gap || 0) >= 2 ? "up" : "";
    html += `<tr>
      <td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td>
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

function refreshAll() {
  const msg = document.getElementById("refreshMsg");
  if (msg) {
    msg.innerHTML = "正在重新拉取最新数据并查询云端更新状态…";
  }
  const ts = new Date().getTime();
  const script = document.createElement("script");
  script.src = "app-data.js?v=" + ts;
  script.onload = () => {
    D = window.DATA;
    renderMeta();
    renderMain();
    renderTrio();
    renderRatio();
    renderWeekly();
    renderSectors();
    renderStocks();
    if (msg) {
      msg.innerHTML = "数据已刷新（更新时间：" + (D.updated_at || "—") + "）";
    }
    queryCloudStatus(msg);
  };
  script.onerror = () => {
    if (msg) msg.innerHTML = "刷新失败，请稍后重试或按 Ctrl+F5 强制刷新。";
  };
  document.body.appendChild(script);
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
