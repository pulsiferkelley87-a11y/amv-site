// 全市场扫描（浏览器端）：东财日线 → 缠论引擎 → 信号池 + 回测
// 之所以放浏览器：本机 Node 出网被拦（腾讯 501 / 东财断连），而浏览器能直连。

const EM = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const LIST = "https://push2.eastmoney.com/api/qt/clist/get";

function emSecid(code) {
  return (/^(6|9)/.test(code) ? "1." : "0.") + code;
}

async function jget(u, ms = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(u, { cache: "no-store", signal: ac.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchKline(code, n = 640) {
  const u = `${EM}?secid=${emSecid(code)}&klt=101&fqt=1&beg=0&end=20500101`
    + `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56`;
  for (let t = 0; t < 2; t++) {
    try {
      const j = await jget(u);
      const k = j?.data?.klines || [];
      if (k.length < 120) return null;
      return k.map((s) => {
        const [d, o, c, h, l, v] = s.split(",");
        return { d, o: +o, c: +c, h: +h, l: +l, v: +v };
      });
    } catch (e) {
      if (t) return null;
    }
  }
  return null;
}

async function fetchList() {
  const out = [];
  for (let pn = 1; pn <= 6; pn++) {
    const u = `${LIST}?pn=${pn}&pz=1000&po=1&np=1&fltt=2&invt=2&fid=f3`
      + `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14`;
    const j = await jget(u, 12000);
    const rows = j?.data?.diff || [];
    if (!rows.length) break;
    for (const r of rows) out.push({ code: String(r.f12), name: String(r.f14) });
    if (rows.length < 1000) break;
  }
  return out;
}

function stats(rs) {
  if (!rs.length) return { n: 0, win: 0, avg: 0, med: 0, pf: 0 };
  const v = rs.slice().sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const win = v.filter((x) => x > 0).length;
  const gp = v.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -v.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    win: +((win / v.length) * 100).toFixed(1),
    avg: +(sum / v.length).toFixed(2),
    med: +v[Math.floor(v.length / 2)].toFixed(2),
    pf: +(gl > 0 ? gp / gl : 0).toFixed(2),
  };
}

export async function scanAll(analyze, opts = {}) {
  const conc = opts.conc || 12;
  const maxN = opts.limit || 99999;
  const t0 = performance.now();
  const onP = opts.onProgress || (() => {});

  onP({ phase: "列表", done: 0, total: 0 });
  let list = await fetchList();
  list = list.slice(0, maxN);
  const total = list.length;
  onP({ phase: "扫描", done: 0, total });

  const recent = [];
  const bt = [];        // {type, ret}
  const counts = { 一买: 0, 二买: 0, 三买: 0, 一卖: 0, 二卖: 0, 三卖: 0 };
  let ok = 0, fail = 0, done = 0, i = 0;

  async function worker() {
    while (i < total) {
      const s = list[i++];
      const bars = await fetchKline(s.code);
      done++;
      if (!bars) { fail++; }
      else {
        ok++;
        let r;
        try { r = analyze(bars); } catch { r = null; }
        if (r) {
          const closes = bars.map((b) => b.c);
          const last = closes.length - 1;
          for (const sg of r.signals) {
            counts[sg.type] = (counts[sg.type] || 0) + 1;
            // 回测：确认滞后 3 根，持有 10 根
            const e = sg.i + 3, x = e + 10;
            if (x < closes.length) {
              bt.push({ type: sg.type, ret: ((closes[x] - closes[e]) / closes[e]) * 100 });
            }
            // 最近 6 根内的信号进池
            if (last - sg.i <= 6) {
              const win = closes.slice(Math.max(0, last - 249), last + 1);
              const lo = Math.min(...win), hi = Math.max(...win);
              const p = sg.p ?? closes[sg.i];
              recent.push({
                code: s.code,
                name: s.name,
                type: sg.type,
                d: bars[sg.i].d,
                days: last - sg.i,
                p: +p.toFixed(2),
                close: +closes[last].toFixed(2),
                pct: +(((closes[last] - p) / p) * 100).toFixed(2),
                pos: hi > lo ? Math.round(((closes[last] - lo) / (hi - lo)) * 100) : null,
                note: sg.note || "",
              });
            }
          }
        }
      }
      if (done % 20 === 0 || done === total) onP({ phase: "扫描", done, total, ok, fail });
    }
  }

  await Promise.all(Array.from({ length: conc }, worker));

  // 汇总
  recent.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  const all = bt.map((x) => x.ret);
  const byType = {};
  for (const t of Object.keys(counts)) {
    const rs = bt.filter((x) => x.type === t).map((x) => x.ret);
    if (rs.length) byType[t] = stats(rs);
  }
  const edges = [-99, -10, -5, -3, 0, 3, 5, 10, 99];
  const buckets = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const a = edges[k], b = edges[k + 1];
    buckets.push({ from: a === -99 ? -20 : a, to: b === 99 ? 20 : b, n: all.filter((x) => x >= a && x < b).length });
  }

  const res = {
    updated_at: new Date().toLocaleString("zh-CN", { hour12: false }),
    ok, fail, ms: Math.round(performance.now() - t0),
    counts,
    signals: recent.slice(0, 800),
    backtest: { all: stats(all), buckets, byType },
    engine: "chan-engine v1 · 东财日线 · 浏览器端扫描",
  };
  onP({ phase: "完成", done: total, total, ok, fail });
  return res;
}
