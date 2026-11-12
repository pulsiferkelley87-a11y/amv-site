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
let ok = 0, fail = 0;

for (const code of codes) {
  const raw = bars[code];
  if (!raw || raw.length < 150) { fail++; continue; }
  const bs = raw.map((r) => ({ d: r[0], o: r[1], c: r[2], h: r[3], l: r[4], v: r[5] }));
  let r;
  try { r = analyze(bs); } catch (e) { fail++; continue; }
  ok++;
  const closes = bs.map((b) => b.c);
  const last = closes.length - 1;

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
  ok, fail, ms: Date.now() - t0,
  counts, totals,
  signals: recent.slice(0, 800),
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
