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
let DROP_DIRTY = false;  // 开关刚变动过：本次渲染要用 replaceMerge 才能真正删掉旧 markPoint

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
  // 数据文件约 2.5-2.7 MB。实测：GitHub Pages 从国内拉要 20-60 秒（经常超时），
  // 腾讯 COS 镜像同一文件只要 0.6-0.9 秒。所以先在 COS 上试多个域，全部失败才回 GitHub Pages。
  const COS_HOSTS = [
    "https://amv-live-1500351250.cos.ap-guangzhou.myqcloud.com",
  ];
  const localUrl = "d2.js.gz?v=" + new Date().getTime();
  // 带时间戳绕过 CDN 缓存：实测 COS 边缘曾一直发 18 天前的旧副本
  const urls = COS_HOSTS.map(h => h + "/d2.js.gz?t=" + Date.now()).concat([localUrl]);

  // 3 秒还没数据就把标题改成"正在下载数据"，避免用户以为卡死
  const slowTimer = setTimeout(function () {
    const mt = document.getElementById("metaTime");
    if (mt && !D) mt.textContent = "正在下载行情数据（约 2.5 MB），国内网络建议等 10-30 秒…";
  }, 3000);

  if (typeof DecompressionStream !== "undefined") {
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const ds = new DecompressionStream("gzip");
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        const txt = await new Response(stream).text();
        const obj = JSON.parse(txt.slice(txt.indexOf("{")).replace(/;\s*$/, ""));
        if (!obj || !obj.updated_at) continue;
        // 防陈旧：COS 镜像可能长期没同步（实测曾停在 18 天前），
        // 此时宁可走慢的 GitHub，也不能把过期数据当最新显示。
        const _t = Date.parse(String(obj.updated_at).replace(" ", "T"));
        const _age = isNaN(_t) ? 0 : (Date.now() - _t);
        if (_age > 3 * 24 * 3600 * 1000) {
          console.warn("[amv] 跳过陈旧数据源:", u, obj.updated_at);
          continue;
        }
        D = obj; break;
      } catch (e) { /* 换下一个源 */ }
    }
    if (D && !D.bull_bear) {
      for (const base of COS_HOSTS.concat([""])) {
        try {
          const r2 = await fetch(base + "/bull_bear.json?v=" + new Date().getTime());
          if (r2.ok) { D.bull_bear = await r2.json(); break; }
        } catch (e2) { }
      }
    }
    if (D) checkDataFreshness();
  }
  clearTimeout(slowTimer);
  if (!D) D = window.DATA;
  if (!D) {
    // 现代浏览器 gz 拉取失败时的回退：改用 app-data.js（与 refreshAll 同一套链路）。
    // d2.js.gz 与 app-data.js.gz 内容一致，故语义等价；失败时不重试，交给 autoRefreshData 兜底。
    if (!window.__amvLoadFallback) {
      window.__amvLoadFallback = true;
      loadDataScript(function () { D = window.DATA; load(); }, function () {});
    }
    return;
  }
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
  renderTdxCheck();
  renderMethodBox();
  renderMain();
  renderTrio();
  renderRatio();
  renderWeekly();
  renderSectors();
  renderStocks();
  renderFlow();
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
  ch.setOption(applyAxisTheme({
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
  }));
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
  const mt = D.market_totals;
  const split = marketSplit();

  document.getElementById("meta").innerHTML =
    `<span id="metaTime">数据更新：${D.updated_at}</span> ｜ 官方序列来源：${src} ｜ 最新交易日 ${o.date[last]} ` +
    `0AMV <b>${amv.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}</b> ` +
    `(<span class="${cls}">${chg >= 0 ? "+" : ""}${chg}%</span>) ` +
    `活跃比例 <b>${(r * 100).toFixed(2)}%</b> ` +
    (mt
      ? `｜ 沪深京成交额 <b>${(mt.amount / 1e12).toFixed(2)}</b> 万亿` +
        (split ? `（沪 ${split.sh} ／ 深 ${split.sz} ／ 北 ${split.bj}）` : "（个股快照合计）") +
        (mt.amount_source === "live_fallback" ? " <span class=\"down\">快照不全，已用实时兜底</span>"
         : (mt.partial ? " <span class=\"down\">快照不全，可能偏低</span>" : ""))
      : "") +
    (D.errors.length ? ` ｜ <span class="down">${D.errors.join("；")}</span>` : "");

  // 供 ui-dashboard.js 直接读取：KPI 条原来靠正则去刮这段 innerHTML，
  // 一旦文案改一个字符（比如"全市场"→"沪深京"）就静默取不到值。
  // __AMV_DATA 是给 fundamentals.js 用的：现代浏览器路径下数据走脚本内 let D，
  // window.DATA 并不存在，外部脚本拿不到 all_stocks，只能由这里透出。
  window.__AMV_DATA = D;
  window.__AMV_META = {
    updated_at: D.updated_at || "",
    lastTradeDate: o.date[last] || "",
    amv: amv,
    amvPct: chg,
    ratio: r * 100,
    amount: mt ? mt.amount / 1e12 : null,
    amountSource: mt ? (mt.amount_source || "") : "",
    amountPartial: !!(mt && mt.partial),
    byMarket: split,
    fundamentalsUpdatedAt: D.fundamentals_updated_at || ""
  };
  markStale(D.updated_at);
}

/* 沪深京成交额拆分：直接按代码前缀从个股快照里算，不改后端口径。
   仅用于让"成交额"这个数字可被核对（沪 + 深 + 北 应等于合计）。
   6/9=沪（含 900 B股），0/2/3=深（含 200 B股），4/8=北交所。 */
function marketSplit() {
  const list = (D && D.all_stocks) || [];
  if (!list.length) return null;
  let sh = 0, sz = 0, bj = 0, other = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i].amount;
    if (!a) continue;
    const c = String(list[i].code || "")[0];
    if (c === "6" || c === "9") sh += a;
    else if (c === "0" || c === "2" || c === "3") sz += a;
    else if (c === "4" || c === "8") bj += a;
    else other += a;
  }
  const t = sh + sz + bj + other;
  if (!t) return null;
  const w = v => (v / 1e12).toFixed(2);
  return { sh: w(sh), sz: w(sz), bj: w(bj), other: w(other), total: w(t) };
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

// 深色模式下 ECharts 的网格线/坐标轴仍是默认浅色（#E0E6F1），会在深底上显示成几道白条。
// 统一在 setOption 前把颜色按主题注入，避免每张图各写一遍。
function applyAxisTheme(opt) {
  const tc = themeColors();
  const fix = (ax, isY) => {
    if (!ax) return;
    ax.axisLabel = Object.assign({ color: tc.text }, ax.axisLabel || {});
    if (isY) {
      ax.splitLine = ax.splitLine || {};
      ax.splitLine.lineStyle = Object.assign({ color: tc.split }, ax.splitLine.lineStyle || {});
      ax.axisLine = Object.assign({ show: false }, ax.axisLine || {});
    } else {
      ax.axisLine = ax.axisLine || {};
      ax.axisLine.lineStyle = Object.assign({ color: tc.axis }, ax.axisLine.lineStyle || {});
      ax.splitLine = Object.assign({ show: false }, ax.splitLine || {});
    }
  };
  if (Array.isArray(opt.xAxis)) opt.xAxis.forEach((a) => fix(a, false)); else fix(opt.xAxis, false);
  if (Array.isArray(opt.yAxis)) opt.yAxis.forEach((a) => fix(a, true)); else fix(opt.yAxis, true);
  opt.textStyle = Object.assign({ color: tc.text }, opt.textStyle || {});
  if (opt.legend) opt.legend.textStyle = Object.assign({ color: tc.text }, opt.legend.textStyle || {});
  return opt;
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
  // 日期轴 = 官方日期 ∪ 自研日期。官方序列来自手工维护的 JSON，会滞后数日；
  // 自研线逐日都有值，若只用官方日期当轴，这根线会被截断在官方最后一天。
  const ps = D.amv_perstock || { date: [], amv: [] };
  const dateSet = Object.create(null);
  (o.date || []).forEach(d => { dateSet[d] = 1; });
  (ps.date || []).forEach(d => { dateSet[d] = 1; });
  const axis = Object.keys(dateSet).sort();
  const alignTo = (srcDates, vals) => {
    const m = Object.create(null);
    (srcDates || []).forEach((d, i) => { m[d] = (vals && vals[i] !== undefined) ? vals[i] : null; });
    return axis.map(d => (d in m ? m[d] : null));
  };
  const axOff = alignTo(o.date, o.amv);
  const axSelf = alignTo(ps.date, ps.amv);
  // 水平锚定：逐股段在官方有值处直接取官方值。
  // 云端拼接目前只做「末端对齐」，中段会鼓出 20-30%（2026-11-06 起就固化了）。
  // 写在这里是为了让下一次云端重算即使又拼歪，图上也不会再出现鼓包。
  for (let i = 0; i < axSelf.length; i++) {
    const sv0 = axSelf[i], ov0 = axOff[i];
    if (sv0 != null && ov0 != null && ov0 > 0) axSelf[i] = ov0;
  }
  // 热启动兜底：逐股递推初值未锚定官方时，会出现「从官方 28% 用两周爬回来」的假 V。
  // 这种点一律置空（宁可断线，也不画假走势）。
  for (let i = 0; i < axSelf.length; i++) {
    const sv = axSelf[i], ov = axOff[i];
    if (sv != null && ov != null && ov > 0 && sv / ov < 0.7) axSelf[i] = null;
  }
  const axMa10 = alignTo(o.date, o.ma10 || []);
  const axMa80 = alignTo(o.date, o.ma80 || []);
  opt.xAxis = { type: "category", data: axis };
  opt.yAxis = { type: "value", scale: true };
  opt.dataZoom = [
    { type: "inside", xAxisIndex: 0 },
    { type: "slider", xAxisIndex: 0, bottom: 5, height: 16 },
  ];
  {
    const total = axis.length;
    const st = Math.max(0, (1 - 500 / total) * 100);
    opt.dataZoom[0].start = st; opt.dataZoom[0].end = 100;
    opt.dataZoom[1].start = st; opt.dataZoom[1].end = 100;
  }
  opt.series = [
    line(axOff, "官方 0AMV", COLORS.official, 2.5),
    { name: "活跃SZ(逐股递推·实测)", type: "line", data: axSelf, showSymbol: false,
      lineStyle: { width: 2.5, color: "#16a085" }, itemStyle: { color: "#16a085" } },
    line(axMa10, "MA10", "#e67e22", 1.2),
    line(axMa80, "MA80(80天周期)", "#2980b9", 1.2),
    line(alignTo(o.date, s.var1), "var1(成交额平滑)", COLORS.var1, 1),
    line(alignTo(o.date, s.c5), "C5", COLORS.c5, 1),
    line(alignTo(o.date, s.c13), "C13", COLORS.c13, 1),
    line(alignTo(o.date, s.c34), "C34", COLORS.c34, 1),
    line(alignTo(o.date, s.cinf), "∞", COLORS.cinf, 1),
  ];
  // −2.3% 事件标记（可开关，近 500 日窗口内）
  if (SHOW_DROP) {
    // 标记必须挂在"默认可见"的系列上：官方 0AMV 在首次渲染时被 legendToggleSelect 关掉，
    // 而 ECharts 不会渲染已取消选中系列的 markPoint，所以钉在原 series[0] 上永远看不见。
    const selfMap = Object.create(null);
    (ps.date || []).forEach((d, i) => { selfMap[d] = ps.amv[i]; });
    const winLo = axis[Math.max(0, axis.length - 520)];   // 只标记当前缩放窗口附近，避免上千个钉
    const winHi = axis[axis.length - 1];
    const dropPts = (D.drop_events || [])
      .filter(e => winLo <= e.date && e.date <= winHi && selfMap[e.date] != null)
      .map(e => ({ coord: [e.date, selfMap[e.date]], value: e.chg + "%" }));
    if (dropPts.length) {
      opt.series[1].markPoint = {
        symbol: "circle", symbolSize: 5,          // 事件占全部交易日约 20%，用大图钉会糊成一片
        label: { show: false },
        itemStyle: { color: "#c0392b", opacity: 0.85 },
        data: dropPts,
      };
    }
  }
  // 官方 0AMV 默认隐藏（不参与比对，点图例可叠加）——仅在首次初始化时执行一次
  opt.series[0].lineStyle.opacity = 0.9;
  // 只有开关刚变动时才整体替换 series（能真正移除 markPoint）；
  // 平时仍用合并模式，保留缩放/图例等交互状态。
  if (DROP_DIRTY) {
    ch.setOption(applyAxisTheme(opt), { replaceMerge: ["series"] });
    DROP_DIRTY = false;
  } else {
    ch.setOption(applyAxisTheme(opt));
  }
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
  ch.setOption(applyAxisTheme(opt));
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
  ch.setOption(applyAxisTheme(opt));
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
  ch.setOption(applyAxisTheme(opt));
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
    ch.setOption(applyAxisTheme({
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
    }));
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
    ch.setOption(applyAxisTheme({
      grid: { left: 90, right: 70, top: 10, bottom: 30 },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
      yAxis: { type: "category", data: data.map(s => s.name) },
      series: [{
        type: "bar", data: data.map(s => s.amount_pct), barMaxWidth: 16,
        itemStyle: { color: COLORS.blue, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", formatter: p => p.value + "%", fontSize: 11 },
      }],
    }));
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
  ch.setOption(applyAxisTheme(opt));
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

/* ===== 行业内排名（对应通达信 INSORT(板块名称,指标,输出,升降序)） =====
 * 个股表同时服务"全市场 / 板块下钻 / 区间回看"三种视图，排名只依赖
 * D.all_stocks 与每只股的 industry，所以统一算一次、按数据版本缓存；
 * fundamentals.js 合并完 industry 后会重绘表格，缓存键里带上 fundamentals_updated_at 就能自动失效。 */
let IND_RANK = null, IND_RANK_KEY = "";
function buildIndRank() {
  const list = (D && D.all_stocks) || [];
  const key = String((D && D.fundamentals_updated_at) || "") + "|" + list.length;
  if (IND_RANK && IND_RANK_KEY === key) return IND_RANK;
  const groups = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s.industry) continue;
    (groups[s.industry] || (groups[s.industry] = [])).push(s);
  }
  const rk = Object.create(null);
  Object.keys(groups).forEach(k => {
    const arr = groups[k].slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));
    const n = arr.length;
    arr.forEach((s, i) => { rk[s.code] = { r: i + 1, n: n }; });
  });
  IND_RANK = rk;
  IND_RANK_KEY = key;
  return rk;
}

/* 「行业内」单元格：5/180，前 10% 标红、后 10% 标绿 */
function indRankCell(s) {
  const rk = buildIndRank()[s.code];
  if (!rk) return "—";
  const pos = rk.r / rk.n;
  const cls = pos <= 0.1 ? "up" : pos >= 0.9 ? "down" : "";
  return `<span class="${cls}" title="涨幅在「${esc(s.industry || "")}」${rk.n} 只中排第 ${rk.r}">${rk.r}/${rk.n}</span>`;
}

function renderStockRows(rows) {
  const fmt = (v, d = 1) =>
    v == null ? "—" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  const isAmv = MODE === "reg";
  const amvField = "amv";
  const amvPctField = "amv_pct";
  // 上市日期：20200716 -> 20-07（年-月），太新（<1年）标红提示次新
  const ipoTxt = v => {
    const d = String(v || "").trim();
    if (!/^\d{8}$/.test(d)) return "—";
    const age = (Date.now() - Date.parse(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8))) / 31557600000;
    const txt = d.slice(2,4) + "-" + d.slice(4,6);
    return age < 1 ? `<span style="color:#c0392b">${txt}</span>` : txt;
  };
  // PE：亏损或缺失显示 "—"，>80 视为极高估值
  const peTxt = v => {
    const pe = Number(v);
    if (!isFinite(pe) || pe <= 0) return "—";
    const color = pe > 80 ? "#c0392b" : (pe > 40 ? "#b8860b" : "");
    return color ? `<span style="color:${color}">${pe.toFixed(1)}</span>` : pe.toFixed(1);
  };
  // 主力净流入（元 -> 亿），红进绿出
  const flowTxt = v => {
    const x = Number(v);
    if (!isFinite(x) || x === 0) return "—";
    const yi = x / 1e8;
    const cls = yi >= 0 ? "up" : "down";
    return `<span class="${cls}">${yi >= 0 ? "+" : ""}${yi.toFixed(2)}</span>`;
  };
  const scoreCell = s => {
    if (s.score == null) return "—";
    const sc = Number(s.score);
    const color = sc >= 70 ? "#d64545" : sc >= 50 ? "#b8860b" : "#2fa36b";
    return `<span style="color:${color};font-weight:700;">${sc.toFixed(0)}</span>`;
  };
  let html = `<table><thead><tr>
    <th>#</th><th>代码</th><th>名称</th><th>行业</th><th>行业内</th><th>上市</th><th>PE</th><th>主力(亿)</th><th>评分</th>` +
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
      <td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td><td>${indRankCell(s)}</td>` +
      `<td>${ipoTxt(s.ipo)}</td><td>${peTxt(s.pe)}</td><td>${flowTxt(s.mainlx)}</td>` +
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

/* ===== 主力资金流面板 ===== */
let FLOW_DESC = true;
function toggleFlowSort() {
  FLOW_DESC = !FLOW_DESC;
  const b = document.getElementById("btnFlow");
  if (b) b.textContent = FLOW_DESC ? "净流入 ↓" : "净流出 ↑";
  renderFlow();
}
function flowKey() {
  const el = document.getElementById("flowKey");
  const v = el ? el.value : "mainlx";
  return ["mainlx", "m3", "m5", "m10", "ddx"].indexOf(v) >= 0 ? v : "mainlx";
}
function renderFlow() {
  const box = document.getElementById("flowBox");
  if (!box) return;
  const note = document.getElementById("flowNote");
  const all = (D.all_stocks || []);
  const key = flowKey();
  const list = all.filter(s => s.mainlx != null && s.mainlx !== 0);

  if (!list.length) {
    // 空态必须说清"为什么空"：数据没发布 / 还没合并，和"真的一只都没有"是两回事。
    const fu = (D && D.fundamentals_updated_at) || "";
    const st = window.__AMV_FUND || {};
    let why, hint;
    if (!all.length) {
      why = "行情主数据尚未加载完成";
      hint = "稍等几秒，或点右上角「🔄 立即刷新」。";
    } else if (fu) {
      why = `基本面文件已加载（${fu}），但合并后没有可用的主力净流入字段`;
      hint = "可能是 fundamentals.json 与当前快照的股票代码对不上，或该次抓取本身为空。";
    } else if (st.state === "error") {
      why = "基本面数据未发布或拉取失败：" + (st.error || "fundamentals.json 不可用");
      hint = "面板依赖 <code>fundamentals.json</code>，它与行情主数据分开更新；缺它时其余页面不受影响。";
    } else if (st.state === "loading") {
      why = "基本面数据正在加载…";
      hint = "这是独立的小文件（约 500 KB），通常 1-2 秒完成。";
    } else {
      why = "基本面数据尚未就绪";
      hint = "跑一次 <code>scripts/fetch_fundamentals.py</code> 后由发布流程带上 <code>fundamentals.json</code> 即可。";
    }
    box.innerHTML = '<div style="color:var(--muted);line-height:1.8">暂无资金流数据 —— ' + why +
      '。<br>' + hint + '</div>';
    if (note) note.textContent = "";
    return;
  }

  const val = s => {
    const x = s[key];
    return (x == null || !isFinite(x)) ? null : Number(x);
  };
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null) return 1;
    if (y == null) return -1;
    return FLOW_DESC ? y - x : x - y;
  });
  const rows = list.slice(0, 30);
  const yi = v => (v == null ? "—" : (v / 1e8 >= 0 ? "+" : "") + (v / 1e8).toFixed(2));
  const cls = v => (v == null ? "" : (v >= 0 ? "up" : "down"));
  const r3 = v => (v == null ? "—" : Number(v).toFixed(3));

  let html = '<table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>行业</th>' +
    '<th>主力净额(亿)</th><th>3日</th><th>5日</th><th>10日</th><th>DDX</th><th>DDY</th>' +
    '<th>自由换手</th><th>标记</th><th>涨跌幅</th>' +
    '</tr></thead><tbody>';
  rows.forEach((s, i) => {
    const pct = s.pct == null ? null : Number(s.pct);
    const pctTxt = pct == null ? "—" : (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
    html += `<tr><td>${i + 1}</td><td>${s.code}</td><td>${s.name}</td><td>${s.industry || "—"}</td>` +
      `<td class="${cls(s.mainlx)}">${yi(s.mainlx)}</td>` +
      `<td class="${cls(s.m3)}">${yi(s.m3)}</td>` +
      `<td class="${cls(s.m5)}">${yi(s.m5)}</td>` +
      `<td class="${cls(s.m10)}">${yi(s.m10)}</td>` +
      `<td>${r3(s.ddx)}</td><td>${r3(s.ddy)}</td>` +
      `<td>${s.fturn == null ? "—" : Number(s.fturn).toFixed(2) + "%"}</td>` +
      `<td>${s.tags || ""}</td>` +
      `<td class="${pct == null ? "" : (pct >= 0 ? "up" : "down")}">${pctTxt}</td></tr>`;
  });
  html += "</tbody></table>";
  box.innerHTML = html;
  window.__LAST_FLOW = rows;   // 供「⬇ CSV」导出当前视图，不用把筛选逻辑抄第二遍

  if (note) {
    const fu = (D && D.fundamentals_updated_at) || "未知";
    const keyName = { mainlx: "今日主力净流入", m3: "3日累计", m5: "5日累计", m10: "10日累计", ddx: "DDX 大单动向" }[key];
    const pos = list.filter(s => (val(s) || 0) > 0).length;
    note.textContent = `覆盖 ${list.length} 只（净流入为正 ${pos} 只）｜ 排序口径：${keyName}｜ 基本面时点：${fu}`;
  }
}

/* ===== 通达信口径核对（TOTALHQINFO 1..6） =====
 * 口径来源：对 TCalc.dll 内置公式帮助文本的静态解析（REA/Ghidra，见 tdx-re/REPORT-64bit.md）。
 * 通达信自己把这些定义成公式函数：
 *   TOTALHQINFO(N)  沪深京市场表现
 *     N:1 上涨家数  2 下跌家数  3 涨停家数  4 跌停家数  5 昨日上涨家数  6 总成交金额(亿元)
 *
 * 涨停家数的分档沿用通达信内置公式里 ZTPRICE 的写法：
 *   北交所 30%、创业板(300/301)/科创板(688/689) 20%、主板 10%、主板 ST 5%
 *   （内置公式原文：ZTJ:=IF(TJ3,ZTPRICE(REF(CLOSE,1),0.3),
 *                        IF(TJ,ZTPRICE(REF(CLOSE,1),0.2),ZTPRICE(REF(CLOSE,1),0.1)))）
 *
 * 局限（必须说清）：本站个股快照只有涨跌幅、没有昨收价，复现不了 ZTPRICE 的"按分取整"，
 * 所以用"涨幅档位 ± 0.10 个百分点"近似。它的用途是让人拿通达信逐个数字对得上，
 * 不是用来做回测或统计口径的唯一真值。 */
function limitPctOf(code, name) {
  const c = String(code || "");
  const nm = String(name || "").toUpperCase();
  const isST = nm.indexOf("ST") >= 0;
  if (c[0] === "4" || c[0] === "8" || c.slice(0, 3) === "920") return 30;
  if (c.slice(0, 3) === "300" || c.slice(0, 3) === "301") return 20;
  if (c.slice(0, 3) === "688" || c.slice(0, 3) === "689") return 20;
  return isST ? 5 : 10;
}

function renderTdxCheck() {
  const el = document.getElementById("tdxCheck");
  if (!el || !D || !D.all_stocks) return;
  const list = D.all_stocks;
  let up = 0, down = 0, flat = 0, zt = 0, dt = 0, amt = 0, n = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const p = s.pct;
    if (p == null || !isFinite(p)) continue;
    n++;
    if (s.amount) amt += s.amount;
    if (p > 0) up++; else if (p < 0) down++; else flat++;
    const lim = limitPctOf(s.code, s.name);
    if (p >= lim - 0.10) zt++;
    else if (p <= -(lim - 0.10)) dt++;
  }
  if (!n) { el.innerHTML = '<span style="color:var(--muted)">等待行情数据…</span>'; return; }

  const mt = D.market_totals;
  const siteAmt = mt ? mt.amount : null;
  const diff = siteAmt ? (amt / siteAmt - 1) * 100 : null;
  const cell = (label, val, extra) =>
    `<span style="display:inline-block;margin-right:22px;">${label} <b style="font-size:15px;">${val}</b>${extra || ""}</span>`;

  el.innerHTML =
    `<div>` +
    cell("上涨", up.toLocaleString()) +
    cell("下跌", down.toLocaleString()) +
    cell("平盘", flat.toLocaleString()) +
    cell("涨停≈", zt) +
    cell("跌停≈", dt) +
    cell("总成交", (amt / 1e8).toFixed(0) + " 亿") +
    `</div>` +
    `<div style="font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.7;">` +
    `样本 ${n.toLocaleString()} 只 ｜ 对应公式 <code>TOTALHQINFO(1..6)</code>（上涨/下跌/涨停/跌停家数 · 总成交金额）` +
    (diff != null
      ? ` ｜ 与「沪深京成交额」${(siteAmt / 1e8).toFixed(0)} 亿的偏差 <b>${diff >= 0 ? "+" : ""}${diff.toFixed(2)}%</b>` +
        (Math.abs(diff) > 0.5 ? ' <span class="down">（口径不一致，需查快照是否缺票）</span>' : ' <span class="up">（一致）</span>')
      : "") +
    `<br>涨停按通达信 ZTPRICE 分档近似：北交所 30% ／ 创业板·科创板 20% ／ 主板 10% ／ 主板 ST 5%，容差 ±0.10 个百分点。` +
    `</div>`;
}

/* ===== 指标口径与阈值（参照大波浪数据"温度是怎么判的"那张表） =====
 *
 * 为什么要有这张表：本页大部分指标是自研的，只给结果不给判定规则，
 * 读者没法复核，只能选择相信。这里把每个指标的**当前值 + 判定 + 阈值**一起摆出来，
 * 阈值全部来自 scripts/bull_bear.py 与 scripts/update_cloud.py 里的实际代码，
 * 不是事后编的说明。
 */
function renderMethodBox() {
  const el = document.getElementById("methodBox");
  if (!el || !D) return;

  const bb = BB_DATA || (D.bull_bear && D.bull_bear.scores ? D.bull_bear : null);
  const s = (bb && bb.scores) || {};
  const total = bb ? bb.total : null;
  const state = bb ? (bb.state || "") : "";

  const fmt1 = v => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(1));
  const ofLast = a => (Array.isArray(a) && a.length ? a[a.length - 1] : null);

  const ratio = ofLast(D.official && D.official.ratio);
  const a2c = (D.about_to_cross || []).length;
  const a2cs = (D.about_to_cross_support || []).length;
  const sig = D.stocks_amv || [];
  const upN = sig.filter(x => x.cross === "up").length;
  const downN = sig.filter(x => x.cross === "down").length;
  const mt = D.market_totals;
  const allN = (D.all_stocks || []).length;
  const mainlxN = (D.all_stocks || []).filter(x => x.mainlx != null).length;

  // 牛熊五档：只标当前落在哪一档，不预测
  const band = total == null ? "—"
    : total >= 35 ? "牛市特征较强"
      : total >= 15 ? "偏多"
        : total >= -14 ? "震荡"
          : total >= -34 ? "偏弱" : "熊市特征较强";

  const rows = [
    ["牛熊总评", fmt1(total), band + (state ? "（" + state + "）" : ""),
      "≥35 牛市特征较强 ｜ 15~34 偏多 ｜ −14~14 震荡 ｜ −34~−15 偏弱 ｜ ≤−35 熊市特征较强"],
    ["价格趋势", fmt1(s.trend), "权重 25%",
      "主要指数相对 MA20/MA60 的位置打分，单维 −100~+100"],
    ["市场广度", fmt1(s.breadth), "权重 20%",
      "(站上60日线%−50)×1.6 + (120日−50)×1.2 + (250日−50)×0.8，再 ÷3.6，钳到 ±100"],
    ["成交量能", fmt1(s.volume), "权重 15%",
      "20日量比 >1.2 记 +30 ／ >1 记 +15 ／ <0.7 记 −30；5日量比 >1.05 记 +20；20日均量趋势 >+5% 记 +20"],
    ["宏观盈利", fmt1(s.macro), "权重 15%",
      "读 macro.json（PMI、工业企业利润增速等，人工维护）；无数据时记 0"],
    ["市场估值", fmt1(s.valuation), "权重 10%",
      "有真实 PE/PB 历史分位时按分位打分，否则退回 macro.json 的手填值"],
    ["情绪杠杆", fmt1(s.sentiment), "权重 15%",
      "上涨占比 >65% 记 +60 ／ >50% +20 ／ <35% −60 ／ 其余 −20；涨停>跌停×2 记 +20；最高连板≥5 记 +20"],
    ["活跃比例", ratio == null ? "—" : (ratio * 100).toFixed(2) + "%", "0AMV ÷ 0号指数",
      "历史区间 7.7% ~ 30.6%（该区间是历史观测值，不是阈值）"],
    ["活跃度递推", "见下方说明", "自研模型",
      "A_t = 0.9169·A_{t−1} + min(换手率÷1.1, 1)·(1−A_{t−1})，半衰期 10 个交易日"],
    ["快上穿十日线", (a2c >= 60 ? "≥60" : a2c) + " 只", "展示上限 60",
      "六条同时满足：① A 仍在 MA10 下方 ② 换手强度 X=min(换手率÷1.1,1) > A ③ A 三日递增 ④ gap 连续两日收窄 ⑤ 预计穿线 ≤3 天 ⑥ 历史序列 ≥15 天"],
    ["快上穿×支撑共振", (a2cs >= 60 ? "≥60" : a2cs) + " 只", "展示上限 60",
      "在「快上穿」基础上，要求现价高于最近支撑位且距离 <3%（普通版支撑距离阈值是 <5%）"],
    ["个股信号 上穿 / 下穿", upN + " / " + downN, "当日拐头数",
      "上穿：前一日 A<MA10 且当日 A≥MA10；下穿反之。分位 = 该股活跃度在自身近 250 日中的位置"],
    ["今日选股 · 活跃度拐头", ((D.picks || []).length) + " 只", "最新交易日触发",
      "A 上穿自身 MA10：前一日 A≤MA10 且当日 A>MA10；当日成交额>0；历史需 ≥70 根 K 线；同时记录 A 的连续上升天数"],
    ["资金流覆盖", mainlxN + " / " + allN, "东财口径",
      "主力净额为东财资金流字段；自由流通换手 = 成交额 ÷ 流通市值；取不到值的股票显示 —，不做插补"],
    ["沪深京成交额", mt ? (mt.amount / 1e12).toFixed(2) + " 万亿" : "—", "个股快照求和",
      "个股 amount 加总；与通达信 TOTALHQINFO(6) 逐项核对，偏差见上方「通达信口径核对」"],
  ];

  const cell = v => esc(v == null ? "—" : String(v));
  el.innerHTML =
    '<div class="rulewrap"><table class="ruletbl"><thead><tr>' +
    '<th>指标</th><th>当前值</th><th>判定</th><th>规则 / 阈值</th>' +
    '</tr></thead><tbody>' +
    rows.map(r =>
      '<tr><td class="rk">' + cell(r[0]) + '</td>' +
      '<td class="rv">' + cell(r[1]) + '</td>' +
      '<td class="rj">' + cell(r[2]) + '</td>' +
      '<td class="rr">' + cell(r[3]) + '</td></tr>').join("") +
    '</tbody></table></div>' +
    '<div class="note" style="margin-top:8px;">' +
    '阈值全部取自 <code>scripts/bull_bear.py</code> 与 <code>scripts/update_cloud.py</code> 的实际判定分支，' +
    '不是事后补的说明。这些是对指标区间的<b>描述</b>，不是买卖建议。' +
    (bb && bb.updated_at ? '　牛熊口径更新：' + esc(bb.updated_at) : '') +
    '</div>';
}

window.renderMethodBox = renderMethodBox;

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
  renderAboutToCrossSupport();
  renderCrossPromotion();
  renderMeta();
  try { renderTdxCheck(); } catch (e) {
    const box = document.getElementById("tdxCheck");
    if (box) box.textContent = "通达信口径核对渲染失败：" + (e && e.message ? e.message : e);
  }
  renderMain();
  renderTrio();
  renderRatio();
  renderWeekly();
  renderSectors();
  renderStocks();
  renderFlow();
  // 整包数据刷新（autoRefreshData / 主题切换）会把 D 换成新对象，
  // 外部合并进来的基本面字段随之丢失。让 fundamentals.js 重新贴一次。
  try { if (typeof window.__AMV_FUND_APPLY === "function") window.__AMV_FUND_APPLY(); } catch (e) { }
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
  let html = `<div style="max-height:340px;overflow-y:auto;"><table><thead><tr><th>代码</th><th>名称</th><th>现价</th><th>涨跌</th><th>活跃度A</th><th>MA10</th><th>距上穿</th><th>预计</th></tr></thead><tbody>`;
  list.forEach(x => {
    const p = x.pct != null ? (x.pct > 0 ? "+" : "") + Number(x.pct).toFixed(2) + "%" : "—";
    const price = x.price != null ? Number(x.price).toFixed(2) : "—";
    const cls = x.pct != null && x.pct >= 0 ? "up" : "down";
    html += `<tr><td>${x.code}</td><td>${x.name}</td><td>${price}</td>
      <td class="${cls}">${p}</td>
      <td>${Number(x.a).toFixed(3)}</td><td>${Number(x.ma10).toFixed(3)}</td>
      <td style="color:#c0392b;"><b>${x.gap_pct}%</b></td><td>${x.days}天</td></tr>`;
  });
  html += "</tbody></table></div>";
  el.innerHTML = html;
}

function renderAboutToCrossSupport() {
  const el = document.getElementById("aboutCrossSupportBox");
  if (!el) return;
  const list = (D && D.about_to_cross_support) || [];
  if (!list.length) {
    el.innerHTML = "<span style='color:var(--muted);'>今日暂无快上穿×支撑共振候选。</span>";
    return;
  }
  let html = `<div style="max-height:340px;overflow-y:auto;"><table><thead><tr><th>代码</th><th>名称</th><th>现价</th><th>涨跌</th><th>活跃度A</th><th>MA10</th><th>距上穿</th><th>预计</th><th>距支撑</th></tr></thead><tbody>`;
  list.forEach(x => {
    const p = x.pct != null ? (x.pct > 0 ? "+" : "") + Number(x.pct).toFixed(2) + "%" : "—";
    const price = x.price != null ? Number(x.price).toFixed(2) : "—";
    const cls = x.pct != null && x.pct >= 0 ? "up" : "down";
    html += `<tr><td>${x.code}</td><td>${x.name}</td><td>${price}</td>
      <td class="${cls}">${p}</td>
      <td>${Number(x.a).toFixed(3)}</td><td>${Number(x.ma10).toFixed(3)}</td>
      <td style="color:#c0392b;"><b>${x.gap_pct}%</b></td><td>${x.days}天</td>
      <td style="color:#2fa36b;"><b>${x.dist}%</b></td></tr>`;
  });
  html += "</tbody></table></div>";
  el.innerHTML = html;
}

function renderCrossPromotion() {
  const el = document.getElementById("crossPromoBox");
  if (!el) return;
  const rows = (D && D.cross_promotion) || [];
  if (!rows.length) {
    el.innerHTML = "<span style='color:var(--muted);'>暂无晋级统计（从明天开始累积：今天名单 → 明天验证上穿）。</span>";
    return;
  }
  let html = "";
  rows.forEach(r => {
    const rate = r.rate != null ? r.rate + "%" : "—";
    const spRate = r.sp_rate != null ? r.sp_rate + "%" : "—";
    html += `<div style="padding:6px 0;border-bottom:1px dashed var(--border);">
      <b>${r.date}</b> 基础名单 ${r.prev} 只 → 晋级 <b style="color:#c0392b;">${r.promoted} 只</b>（<b style="color:#c0392b;">${rate}</b>）
      <div style="font-size:12.5px;margin-top:2px;">🎯 共振名单 ${r.sp_prev} 只 → 晋级 <b style="color:#c0392b;">${r.sp_promoted} 只</b>（<b style="color:#c0392b;">${spRate}</b>）</div>
      <div style="font-size:12px;color:var(--muted);margin-top:3px;">基础晋级：${(r.list || []).map(x => x.name).join("、") || "无"}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px;">共振晋级：${(r.sp_list || []).map(x => x.name).join("、") || "无"}</div>
    </div>`;
  });
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
        try { renderMethodBox(); } catch (e) { }
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
      const W = 660, H = 156, PL = 40, PR = 16, PT = 24, PB = 18;  // PT 加大：标题带在绘图区之外
      const iw = W - PL - PR, ih = H - PT - PB;
      const x = i => PL + (i / (h.length - 1)) * iw;
      const y = v => PT + (1 - (v + 100) / 200) * ih;
      let d = "";
      h.forEach((p, i) => { d += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.score).toFixed(1); });
      let labels = "";
      let lastYear = "";  // 抽样点可能落在同一年，去重避免重复年份
      h.forEach((p, i) => {
        if (i % 200 === 0 || i === h.length - 1) {
          const yr = p.date.slice(0, 4);
          if (yr === lastYear) return;
          lastYear = yr;
          const anchor = i === 0 ? "start" : (i === h.length - 1 ? "end" : "middle");
          labels += `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-size="9" fill="var(--muted)" text-anchor="${anchor}">${yr}</text>`;
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
        <text x="${PL}" y="14" font-size="9" fill="var(--muted)">牛熊趋势分数回测（仅趋势模块·官方0AMV vs 均线，约5年）</text>
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
  DROP_DIRTY = true;   // setOption 默认合并，不整体替换的话旧 markPoint 会一直留着
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

/* 自检：?selftest=drop 时验证 -2.3% 标记开关是否真的改变图上的 markPoint */
if (/[?&]selftest=drop/.test(location.search)) {
  setTimeout(function () {
    try {
      var dom = document.getElementById("chartMain");
      var ch = echarts.getInstanceByDom(dom);
      var mpOf = function () {
        var o = ch.getOption();
        var s1 = (o.series || [])[1] || {};
        var mp = s1.markPoint;
        if (!mp) return 0;
        var arr = Array.isArray(mp) ? mp[0] : mp;
        return (arr && arr.data) ? arr.data.length : 0;
      };
      var before = mpOf();
      toggleDrop();                    // 关掉
      setTimeout(function () {
        var afterOff = mpOf();
        toggleDrop();                  // 再打开
        setTimeout(function () {
          document.title = "SELFTEST drop before=" + before +
            " afterOff=" + afterOff + " afterOn=" + mpOf() +
            " showDrop=" + SHOW_DROP;
        }, 400);
      }, 400);
    } catch (e) {
      document.title = "SELFTEST drop ERROR " + e.message;
    }
  }, 5000);
}

/* ===== 个股分时弹窗 =====
   数据来自 app-data 的 D.intraday{code:{name,date,now,avg,bars:[[秒,价,量]]}}，
   后端每天抓一次（贡献榜前 40 + 选股前 20）。点任意表格里带 6 位代码的行即可打开。 */
let _intraCh = null;

function _intraModal() {
  let m = document.getElementById("intraModal");
  if (m) return m;
  m = document.createElement("div");
  m.id = "intraModal";
  m.className = "intra-modal";
  m.innerHTML = '<div class="intra-box">' +
    '<div class="intra-head"><span id="intraTitle">分时</span>' +
    '<button class="intra-close" type="button" aria-label="关闭">×</button></div>' +
    '<div id="intraChart" style="width:100%;height:340px"></div></div>';
  document.body.appendChild(m);
  m.querySelector(".intra-close").addEventListener("click", closeIntraday);
  m.addEventListener("click", function (e) { if (e.target === m) closeIntraday(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeIntraday();
  });
  return m;
}

function closeIntraday() {
  const m = document.getElementById("intraModal");
  if (m) m.style.display = "none";
}

function openIntraday(code) {
  const it = (D.intraday || {})[code];
  const m = _intraModal();
  const title = m.querySelector("#intraTitle");
  if (!it) {
    title.textContent = code + " · 暂无分时数据（仅收录贡献榜前 40 与选股前 20）";
    m.style.display = "flex";
    return;
  }
  m.style.display = "flex";
  const now = it.now != null ? Number(it.now) : null;
  const pre = it.pre != null ? Number(it.pre) : null;      // 昨收：涨跌幅基准
  const first = it.bars.length ? it.bars[0][1] : null;
  const chg = (now != null && pre) ? (now / pre - 1) * 100
            : ((now != null && first) ? (now / first - 1) * 100 : null);
  const cls = chg == null ? "" : (chg >= 0 ? "up" : "down");
  title.innerHTML = '<b>' + (it.name || "") + '</b> ' + code +
    (now != null ? ' <span class="' + cls + '">' + now.toFixed(2) +
      (chg != null ? ' ' + (chg >= 0 ? "+" : "") + chg.toFixed(2) + '%' : '') + '</span>' : '') +
    ' <span class="intra-date">' + (it.date || "") + '</span>';

  const xs = it.bars.map(function (b) {
    const s = b[0];
    const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  });
  const ys = it.bars.map(function (b) { return b[1]; });
  const vols = it.bars.map(function (b) { return b[2]; });
  const avg = it.avg != null ? Number(it.avg) : null;
  // 均价线：优先用后端算好的累计 VWAP（逐笔累计成交额/成交量），没有再退回单值
  const avgs = (it.avgs && it.avgs.length === it.bars.length) ? it.avgs : xs.map(function () { return avg; });
  const color = (chg != null && chg < 0) ? "#1e9e6a" : "#c0392b";

  const dom = document.getElementById("intraChart");
  const ch = _intraCh || echarts.init(dom);
  _intraCh = ch;
  ch.setOption(applyAxisTheme({
    animation: false,
    grid: [{ left: 56, right: 56, top: 16, height: 200 }, { left: 56, right: 56, top: 236, height: 56 }],
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    xAxis: [
      { type: "category", data: xs, boundaryGap: false, axisLabel: { fontSize: 10 } },
      { type: "category", data: xs, gridIndex: 1, boundaryGap: false, axisLabel: { show: false } },
    ],
    yAxis: [
      { scale: true, splitLine: { lineStyle: { opacity: 0.4 } }, axisLabel: { fontSize: 10 } },
      { gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
    ],
    series: [
      { name: "价格", type: "line", data: ys, showSymbol: false,
        lineStyle: { width: 1.8, color: color }, itemStyle: { color: color },
        areaStyle: { opacity: 0.08, color: color },
        markLine: pre ? { silent: true, symbol: "none",
          lineStyle: { type: "dashed", color: "#8b93a1", width: 1 },
          label: { formatter: pre.toFixed(2), position: "insideEndTop", fontSize: 10, color: "#8b93a1" },
          data: [{ yAxis: pre }] } : undefined },
      { name: "均价", type: "line", data: avgs, showSymbol: false,
        lineStyle: { width: 1, type: "dashed", color: "#e67e22" } },
      { name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: vols,
        itemStyle: { color: "rgba(120,140,180,.55)" } },
    ],
  }), { notMerge: true });
}

/* 表格行点击：找行内第一个 6 位数字当成股票代码 */
document.addEventListener("click", function (e) {
  const tr = e.target && e.target.closest ? e.target.closest("tr") : null;
  if (!tr || (tr.closest && tr.closest("#intraModal"))) return;
  const tds = tr.querySelectorAll("td");
  for (let i = 0; i < tds.length; i++) {
    const t = (tds[i].textContent || "").trim();
    if (/^\d{6}$/.test(t) && D && D.intraday && D.intraday[t]) {
      openIntraday(t);
      return;
    }
  }
});

/* 调试/分享：?intra=600000 直接打开某只股票的分时 */
(function () {
  const mm = /[?&]intra=(\d{6})/.exec(location.search);
  if (!mm) return;
  const code = mm[1];
  let tries = 0;
  const t = setInterval(function () {
    if (typeof D !== "undefined" && D && D.intraday) { clearInterval(t); openIntraday(code); }
    else if (++tries > 40) clearInterval(t);
  }, 400);
})();

/* ===== 主力资金流：导出当前视图为 CSV（带 BOM，Excel 直接打开） ===== */
function exportFlowCsv() {
  const rows = window.__LAST_FLOW || [];
  if (!rows.length) { alert("当前没有可导出的资金流数据"); return; }
  const head = ["代码", "名称", "行业", "主力净额(亿)", "3日(亿)", "5日(亿)", "10日(亿)", "DDX", "DDY", "自由换手%", "涨跌幅%"];
  const q = v => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const yi = v => (v == null || !isFinite(v)) ? "" : (v / 1e8).toFixed(2);
  const lines = [head.join(",")];
  rows.forEach(s => {
    lines.push([
      s.code, s.name, s.industry || "",
      yi(s.mainlx), yi(s.m3), yi(s.m5), yi(s.m10),
      s.ddx != null ? s.ddx : "", s.ddy != null ? s.ddy : "",
      s.fturn != null ? s.fturn : "", s.pct != null ? s.pct : "",
    ].map(q).join(","));
  });
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = "amv-flow-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") + ".csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/* "/" 快捷聚焦搜索框（不在输入框内时才生效） */
document.addEventListener("keydown", function (e) {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const box = document.getElementById("sigSearch") || document.getElementById("pickDateSel");
  if (box && box.focus) { e.preventDefault(); box.focus(); box.select && box.select(); }
});
