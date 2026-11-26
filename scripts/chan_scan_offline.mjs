// 全市场缠论离线扫描（CI 版）：读分片日线 → 引擎 → chan_scan.json + chan/{code}.json
// 环境变量：
//   CHAN_BARS  分片目录（默认 _chan/bars）
//   CHAN_OUT   输出目录（默认 _chan/out）
//   CLOUD_DIR  仓库根（读 data/data.json，默认 .）
import fs from "node:fs";
import path from "node:path";
import { analyze } from "../chan-engine.js";

const ROOT = process.env.CLOUD_DIR || ".";
const BARS = process.env.CHAN_BARS || path.join(ROOT, "_chan/bars");
const OUT = process.env.CHAN_OUT || path.join(ROOT, "_chan/out");
const POOL = path.join(OUT, "chan");

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data/data.json"), "utf8"));
const nameOf = new Map(
  (data.all_stocks || []).map((s) => [String(s.code).padStart(6, "0"), s.name || ""])
);

const files = fs.readdirSync(BARS).filter((f) => f.endsWith(".json")).sort();
const bars = {};
for (const f of files) Object.assign(bars, JSON.parse(fs.readFileSync(path.join(BARS, f), "utf8")));
const codes = Object.keys(bars).sort();
console.log("分片", files.length, "股票", codes.length);

const t0 = Date.now();
const recent = [];
const bt = [];
const counts = { 一买: 0, 二买: 0, 三买: 0, 一卖: 0, 二卖: 0, 三卖: 0 };
const totals = { 一买: 0, 二买: 0, 三买: 0, 一卖: 0, 二卖: 0, 三卖: 0 };
const COST = 0.2;
const S1 = [];
const S1BT = [];
const S1BT10 = [];
let skip = 0;
let ok = 0, fail = 0;

for (const code of codes) {
  const raw = bars[code];
  if (!raw || raw.length < 150) { fail++; continue; }
  const nmRaw = nameOf.get(code) || "";
  if (/ST|退/.test(nmRaw)) { skip++; continue; }
  if (!raw[raw.length - 1][5]) { skip++; continue; }
  const bs = raw.map((r) => ({ d: r[0], o: r[1], c: r[2], h: r[3], l: r[4], v: r[5] }));
  let r;
  try { r = analyze(bs); } catch (e) { fail++; continue; }
  ok++;
  const closes = bs.map((b) => b.c);
  const last = closes.length - 1;
  const segL = r.segs && r.segs.length ? r.segs[r.segs.length - 1] : null;
  const pvL = r.pivots && r.pivots.length ? r.pivots[r.pivots.length - 1] : null;
  const cNow = closes[last];
  const trend = segL ? segL.dir : 0;
  const posw = pvL ? (cNow > pvL.zg ? 1 : cNow < pvL.zd ? -1 : 0) : 0;
  const stScore = trend + posw;
  const stTag =
    (trend === 1 ? "向上" : trend === -1 ? "向下" : "无段") +
    "·" +
    (posw === 1 ? "中枢上" : posw === -1 ? "中枢下" : "中枢内");

  // ===== 策略 A：超跌反转（当日候选 + 滚动回测）=====
  if (closes.length >= 70) {
    for (let i = 30; i < closes.length - 5; i++) {
      const c20 = closes[i - 20];
      if (!c20) continue;
      const r20 = ((closes[i] - c20) / c20) * 100;
      if (r20 > -12) continue;
      let sc = 0, sv = 0;
      for (let k = i - 4; k <= i; k++) { sc += closes[k]; sv += bs[k].v; }
      const m5 = sc / 5, a5 = sv / 5;
      if (!(closes[i] > m5 * 0.97)) continue;
      if (!(a5 > 0 && bs[i].v < a5 * 0.9)) continue;
      if (!(bs[i].c > bs[i - 1].h)) continue;
      S1BT.push(((closes[i + 5] - closes[i]) / closes[i]) * 100 - COST);
      if (i + 10 < closes.length) S1BT10.push(((closes[i + 10] - closes[i]) / closes[i]) * 100 - COST);
    }
    let sc = 0, sv = 0;
    for (let k = closes.length - 5; k < closes.length; k++) { sc += closes[k]; sv += bs[k].v; }
    const m5 = sc / 5, a5 = sv / 5;
    const cN = closes[last], c20N = closes[last - 20];
    const r20N = c20N ? ((cN - c20N) / c20N) * 100 : 0;
    if (c20N && r20N <= -12 && cN > m5 * 0.97 && a5 > 0 && bs[last].v < a5 * 0.9 && cN > bs[last - 1].h) {
      const low3 = Math.min(bs[last].l, bs[last - 1].l, bs[last - 2].l);
      const stop = low3 * 0.99, risk = cN - stop;
      if (risk > 0) S1.push({
        code, name: nameOf.get(code) || "", d: bs[last].d, close: +cN.toFixed(2),
        r20: +r20N.toFixed(1), vr: +(bs[last].v / a5).toFixed(2),
        stop: +stop.toFixed(2), tgt: +(cN + risk * 1.8).toFixed(2), rr: 1.8,
        why: "20日跌 " + r20N.toFixed(1) + "% · 量能 " + (bs[last].v / a5).toFixed(2) + "× · 阳包阴收复MA5",
      });
    }
  }

  for (const sg of r.signals) {
    totals[sg.type] = (totals[sg.type] || 0) + 1;
    const e = sg.i + 3, x = e + 10;
    if (x < closes.length) bt.push({ type: sg.type, ret: ((closes[x] - closes[e]) / closes[e]) * 100 });
    if (last - sg.i <= 10) {
      const win = closes.slice(Math.max(0, last - 249), last + 1);
      const lo = Math.min(...win), hi = Math.max(...win);
      const p = sg.p ?? closes[sg.i];
      counts[sg.type] = (counts[sg.type] || 0) + 1;
      recent.push({
        code, name: nameOf.get(code) || "", type: sg.type,
        d: bs[sg.i].d, days: last - sg.i,
        p: +p.toFixed(2), close: +closes[last].toFixed(2),
        pct: +(((closes[last] - p) / p) * 100).toFixed(2),
        pos: hi > lo ? Math.round(((closes[last] - lo) / (hi - lo)) * 100) : null,
        note: sg.note || "",
        tag: stTag, st: stScore,
      });
    }
  }
  if (ok % 800 === 0) console.log(ok, "只", ((Date.now() - t0) / 1000).toFixed(0), "s");
}

function stats(rs) {
  if (!rs.length) return { n: 0, win: 0, avg: 0, med: 0, pf: 0 };
  const v = rs.slice().sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const gp = v.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -v.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    win: +((v.filter((x) => x > 0).length / v.length) * 100).toFixed(1),
    avg: +(sum / v.length).toFixed(2),
    med: +v[Math.floor(v.length / 2)].toFixed(2),
    pf: +(gl > 0 ? gp / gl : 0).toFixed(2),
  };
}

recent.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
const byType = {};
for (const t of Object.keys(counts)) {
  const rs = bt.filter((x) => x.type === t).map((x) => x.ret);
  if (rs.length) byType[t] = stats(rs);
}
const edges = [-99, -10, -5, -3, 0, 3, 5, 10, 99];
const buckets = [];
for (let k = 0; k < edges.length - 1; k++) {
  const a = edges[k], b = edges[k + 1];
  buckets.push({ from: a === -99 ? -20 : a, to: b === 99 ? 20 : b, n: bt.filter((x) => x.ret >= a && x.ret < b).length });
}

const res = {
  updated_at: new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
  ok, fail, skip, ms: Date.now() - t0,
  strat: {
    s1: S1.sort((a, b) => a.r20 - b.r20).slice(0, 150),
    s2: recent
      .filter((x) => (x.type === "二买" || x.type === "三买") && x.days <= 3)
      .map((x) => {
        const stop = +(x.p * 0.985).toFixed(2);
        const risk = x.close - stop;
        return {
          code: x.code, name: x.name, type: x.type, d: x.d, days: x.days,
          close: x.close, stop, tgt: +(x.close + risk * 2).toFixed(2), rr: 2,
          tag: x.tag, why: x.type + " · " + x.tag + " · " + x.days + " 日前",
        };
      })
      .filter((x) => x.close > x.stop)
      .filter((x, i, arr) => arr.findIndex((y) => y.code === x.code) === i)
      .slice(0, 150),
    stat: { s1: stats(S1BT), s1_10: stats(S1BT10), erMai: byType["二买"] || null, sanMai: byType["三买"] || null },
    rule: {
      s1: "20日跌幅≤-12% + 收盘站回MA5(≥-3%) + 缩量(量<5日均量x0.9) + 阳包阴(收>昨高)；止损=近3日最低x0.99，目标=1.8倍风险",
      s2: "缠论二买/三买 且 3日内；止损=买点x0.985，目标=2倍风险",
    },
  },
  counts, totals,
  signals: recent
    .slice()
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)),
  backtest: { all: stats(bt.map((x) => x.ret)), buckets, byType },
  engine: "chan-engine v1 · 通达信日线(CI dump) · 离线扫描",
};

fs.mkdirSync(POOL, { recursive: true });
const poolCodes = [...new Set(recent.map((x) => x.code))];
for (const c of poolCodes) {
  const raw = bars[c];
  if (!raw) continue;
  fs.writeFileSync(path.join(POOL, c + ".json"), JSON.stringify({ code: c, bars: raw }));
}
fs.writeFileSync(path.join(OUT, "chan_scan.json"), JSON.stringify(res));

console.log("统计 ok", ok, "fail", fail, "total", codes.length);
console.log("信号", JSON.stringify(counts), "池", recent.length, "池文件", poolCodes.length);
console.log("回测", JSON.stringify(res.backtest.all));
