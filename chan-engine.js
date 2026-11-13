// 缠论引擎（纯函数，浏览器与 Node 共用）
// 输入：bars = [{d,o,h,l,c,v}] 升序
// 输出：合并K线 / 分型 / 笔 / 线段 / 中枢 / MACD / 买卖点

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ema = (n) => {
    const k = 2 / (n + 1);
    const out = [];
    let prev = closes[0];
    for (let i = 0; i < closes.length; i++) {
      prev = i === 0 ? closes[0] : closes[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };
  const ef = ema(fast), es = ema(slow);
  const dif = closes.map((_, i) => ef[i] - es[i]);
  const k = 2 / (sig + 1);
  const dea = [];
  let p = dif[0];
  for (let i = 0; i < dif.length; i++) {
    p = i === 0 ? dif[0] : dif[i] * k + p * (1 - k);
    dea.push(p);
  }
  const hist = dif.map((x, i) => 2 * (x - dea[i]));
  return { dif, dea, hist };
}

// 1) 包含处理
export function mergeBars(bars) {
  const out = [];
  for (let bi = 0; bi < bars.length; bi++) {
    const b = bars[bi];
    const cur = { d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, i0: bi, src: [b.d] };
    if (out.length < 2) { out.push(cur); continue; }
    const prev = out[out.length - 1];
    const inside = (cur.h <= prev.h && cur.l >= prev.l) || (cur.h >= prev.h && cur.l <= prev.l);
    if (!inside) { out.push(cur); continue; }
    // 方向：用前两根合并K线判断
    const prev2 = out[out.length - 2];
    const up = prev.h >= prev2.h;
    if (up) { prev.h = Math.max(prev.h, cur.h); prev.l = Math.max(prev.l, cur.l); }
    else { prev.h = Math.min(prev.h, cur.h); prev.l = Math.min(prev.l, cur.l); }
    prev.c = cur.c; prev.v += cur.v; prev.src.push(b.d);
  }
  return out;
}

// 2) 分型
export function fractals(m) {
  const fs = [];
  for (let i = 1; i < m.length - 1; i++) {
    const a = m[i - 1], b = m[i], c = m[i + 1];
    if (b.h > a.h && b.h > c.h && b.l > a.l && b.l > c.l) fs.push({ k: "top", i, d: b.d, p: b.h });
    else if (b.l < a.l && b.l < c.l && b.h < a.h && b.h < c.h) fs.push({ k: "bot", i, d: b.d, p: b.l });
  }
  return fs;
}

// 3) 笔：顶底交替，中间至少 1 根合并K线（间隔 >= 4 个合并K线下标）
export function strokes(fs, m) {
  const st = [];
  for (const f of fs) {
    if (!st.length) { st.push({ ...f, i0: f.i, i1: f.i, p0: f.p, p1: f.p }); continue; }
    const last = st[st.length - 1];
    if (f.k === last.k) {
      // 同类分型取更极端
      if ((f.k === "top" && f.p >= last.p) || (f.k === "bot" && f.p <= last.p)) {
        last.p = f.p; last.i = f.i; last.d = f.d; last.p1 = f.p; last.i1 = f.i;
      }
      continue;
    }
    if (f.i - last.i < 4) continue; // 间隔不足，不成笔
    st.push({ k: f.k, i: f.i, d: f.d, p: f.p, i0: last.i, i1: f.i, p0: last.p, p1: f.p });
  }
  return st;
}

// 把笔切成有方向的数组
export function strokeList(st) {
  const out = [];
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1], b = st[i];
    out.push({
      k: b.k, dir: b.k === "top" ? 1 : -1, // 向上笔 ends at top
      i0: a.i, i1: b.i, d0: a.d, d1: b.d,
      p0: a.p, p1: b.p,
      hi: Math.max(a.p, b.p), lo: Math.min(a.p, b.p),
      amp: Math.abs(b.p - a.p),
      t0: a.i, t1: b.i,
    });
  }
  return out;
}

// 特征序列包含处理（对笔的区间）
function mergeFeat(seq) {
  const out = [];
  for (const f of seq) {
    if (!out.length) { out.push({ ...f, idx: [f.idx] }); continue; }
    const prev = out[out.length - 1];
    const inside = (f.hi <= prev.hi && f.lo >= prev.lo) || (f.hi >= prev.hi && f.lo <= prev.lo);
    if (!inside) { out.push({ ...f, idx: [f.idx] }); continue; }
    const up = f.hi > prev.hi;
    if (up) { prev.hi = Math.max(prev.hi, f.hi); prev.lo = Math.max(prev.lo, f.lo); }
    else { prev.hi = Math.min(prev.hi, f.hi); prev.lo = Math.min(prev.lo, f.lo); }
    prev.idx.push(f.idx);
  }
  return out;
}

// 4) 线段：特征序列分型终结
export function segments(sl) {
  if (sl.length < 3) return [];
  const segs = [];
  let start = 0;
  let dir = sl[0].dir;

  const tryBreak = (from) => {
    // 从 from 开始，取反向笔作为特征序列
    const seq = [];
    for (let i = from; i < sl.length; i++) {
      if (sl[i].dir !== dir) seq.push({ ...sl[i], idx: i });
    }
    const merged = mergeFeat(seq);
    for (let j = 1; j < merged.length - 1; j++) {
      const a = merged[j - 1], b = merged[j], c = merged[j + 1];
      if (dir === 1 && b.hi > a.hi && b.hi > c.hi) return { at: b.idx[0], kind: "top" };
      if (dir === -1 && b.lo < a.lo && b.lo < c.lo) return { at: b.idx[0], kind: "bot" };
    }
    return null;
  };

  let guard = 0;
  while (start < sl.length - 2 && guard++ < 4000) {
    const br = tryBreak(start + 1);
    if (!br) break;
    // 线段终点：破坏笔之前那一笔的终点
    let endIdx = Math.max(start + 2, br.at - 1);
    if (endIdx <= start) endIdx = start + 2;
    const part = sl.slice(start, endIdx + 1);
    const hi = Math.max(...part.map((s) => s.p1));
    const lo = Math.min(...part.map((s) => s.p1));
    const p1 = dir === 1 ? hi : lo;
    const last = part[part.length - 1];
    // 端点必须落在「产生极值的那一笔」上：p1 取段内最高/最低，
    // 而这一价可能出现在段中间，若用最后一笔的 i1 会与 p1 错位（图上表现为信号点飘在K线外）
    const ext = part.find((s) => (dir === 1 ? s.p1 === hi : s.p1 === lo)) || last;
    segs.push({
      dir, i0: sl[start].i0, i1: ext.i1, d0: sl[start].d0, d1: ext.d1,
      p0: sl[start].p0, p1, hi, lo, strokes: part.length,
      amp: Math.abs(p1 - sl[start].p0),
    });
    start = endIdx + 1;
    dir = -dir;
  }
  if (start < sl.length - 1) {
    const part = sl.slice(start);
    const hi = Math.max(...part.map((s) => s.p1));
    const lo = Math.min(...part.map((s) => s.p1));
    // 未完成段同样要把端点钉在产生极值的那一笔上
    const extT = part.find((s) => (dir === 1 ? s.p1 === hi : s.p1 === lo)) || part[part.length - 1];
    segs.push({
      dir, i0: part[0].i0, i1: extT.i1,
      d0: part[0].d0, d1: extT.d1,
      p0: part[0].p0, p1: dir === 1 ? hi : lo, hi, lo, strokes: part.length, open: true,
      amp: Math.abs((dir === 1 ? hi : lo) - part[0].p0),
    });
  }
  return segs;
}

// 5) 中枢：连续三笔（或三段）重叠
export function pivotsByStrokes(sl) {
  const pv = [];
  let i = 0;
  while (i < sl.length - 2 && pv.length < 2000) {
    const a = sl[i], b = sl[i + 1], c = sl[i + 2];
    const zg = Math.min(a.hi, b.hi, c.hi);
    const zd = Math.max(a.lo, b.lo, c.lo);
    if (zg <= zd) { i++; continue; }
    // 延伸
    let j = i + 3;
    let hi = zg, lo = zd;
    while (j < sl.length) {
      const s = sl[j];
      // 中枢延伸：该笔终点仍落在 [zd, zg] 内；终点跑出区间即「离开笔」，不算中枢
      if (s.p1 <= zg && s.p1 >= zd) {
        hi = Math.max(hi, s.hi); lo = Math.min(lo, s.lo); j++;
      } else break;
    }
    pv.push({
      i0: a.i0, i1: sl[j - 1].i1, d0: a.d0, d1: sl[j - 1].d1,
      zd, zg, gg: hi, dd: lo, n: j - i, done: j < sl.length,
    });
    i = j;
  }
  return pv;
}

// 6) 背驰：比较相邻两段同向走势的力度（幅度 × MACD 面积）
export function divergences(sl, md, mi) {
  const out = [];
  for (let i = 2; i < sl.length; i++) {
    const cur = sl[i], prev = sl[i - 2];
    if (cur.dir !== prev.dir) continue;
    const area = (s) => {
      let sum = 0;
      const from = s.i0, to = s.i1;
      for (let k = from; k <= to; k++) {
        const h = md.hist[mi[k]] ?? 0;
        if (s.dir === 1 ? h > 0 : h < 0) sum += Math.abs(h);
      }
      return sum;
    };
    const a1 = area(prev), a2 = area(cur);
    const ampOf = (s) => (s.amp != null ? s.amp : Math.abs(s.p1 - s.p0));
    const mid = (cur.p1 + prev.p1) / 2 || 1;
    const bigEnough = ampOf(cur) / mid > 0.03;           // 幅度至少 3%，过滤小波动
    const stronger = bigEnough && ampOf(cur) < ampOf(prev) * 0.9 && a2 < a1 * 0.85;
    if (stronger) out.push({ kind: cur.dir === 1 ? "top" : "bot", at: cur, prev, area1: a1, area2: a2 });
  }
  return out;
}

// 7) 买卖点
export function signals(sl, pv, dv, bars, mi) {
  const sig = [];
  const price = (i) => { const k = mi[i]; return k == null ? null : bars[k].c; };

  // 三买/三卖：离开中枢后的第一笔回踩不破 ZG（三买）或不破 ZD（三卖）
  for (const p of pv) {
    // 从中枢最后一笔之后开始找「离开笔 → 回抽笔」
    for (let i = 1; i < sl.length; i++) {
      const s = sl[i];
      if (s.i1 <= p.i1) continue;
      const pb = sl[i + 1];
      if (s.dir === 1) {
        // 向上离开后，第一个下跌笔不回到 ZG 之下 = 三买
        if (pb && pb.dir === -1 && pb.p1 > p.zg) {
          sig.push({ type: "三买", d: pb.d1, p: pb.p1, i: pb.i1, note: `回踩不破 ZG ${p.zg.toFixed(2)}` });
        }
      } else {
        if (pb && pb.dir === 1 && pb.p1 < p.zd) {
          sig.push({ type: "三卖", d: pb.d1, p: pb.p1, i: pb.i1, note: `反抽不破 ZD ${p.zd.toFixed(2)}` });
        }
      }
      break;
    }
  }

  // 一买/一卖：背驰点
  for (const d of dv) {
    if (d.kind === "bot") sig.push({ type: "一买", d: d.at.d1, p: d.at.p1, i: d.at.i1, note: "下跌背驰" });
    if (d.kind === "top") sig.push({ type: "一卖", d: d.at.d1, p: d.at.p1, i: d.at.i1, note: "上涨背驰" });
  }

  // 二卖：一卖之后第一次反弹不破一卖高点
  const sells = sig.filter((s) => s.type === "一卖").sort((a, b) => a.i - b.i);
  for (const s0 of sells) {
    for (let i = 1; i < sl.length - 1; i++) {
      if (sl[i].i1 <= s0.i) continue;
      if (sl[i].dir === 1 && sl[i].p1 < s0.p && sl[i + 1] && sl[i + 1].dir === -1) {
        sig.push({ type: "二卖", d: sl[i].d1, p: sl[i].p1, i: sl[i].i1, note: "反弹不破一卖 " + s0.p.toFixed(2) });
        break;
      }
    }
  }

  // 二买：一买之后第一次回调不破一买低点
  const buys = sig.filter((s) => s.type === "一买").sort((a, b) => a.i - b.i);
  for (const b of buys) {
    for (let i = 1; i < sl.length - 1; i++) {
      if (sl[i].i1 <= b.i) continue;
      if (sl[i].dir === -1 && sl[i].p1 > b.p && sl[i + 1] && sl[i + 1].dir === 1) {
        sig.push({ type: "二买", d: sl[i].d1, p: sl[i].p1, i: sl[i].i1, note: `回调不破一买 ${b.p.toFixed(2)}` });
        break;
      }
    }
  }

  // 去重 + 按时间排序
  const seen = new Set();
  return sig
    .filter((s) => {
      const k = `${s.type}@${s.i}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    })
    .sort((a, b) => a.i - b.i);
}

export function analyze(bars) {
  const closes = bars.map((b) => b.c);
  const md = macd(closes);
  const m = mergeBars(bars);
  const fs = fractals(m);
  const st = strokes(fs, m);
  const sl = strokeList(st);
  const segs = segments(sl);
  const pv = pivotsByStrokes(sl);
  const dv = divergences(segs.length >= 4 ? segs : sl, md, m.map((x) => x.i0));

  // 合并K线下标 -> 原始 bars 下标
  const mi = m.map((x) => x.i0);
  const sig = signals(sl, pv, dv, bars, mi);
  // signals 里的 i 是「合并K线」下标，统一下标到原始 bars，供回测/定位使用
  for (const s of sig) { const k = m[s.i]; if (k) s.i = k.i0; }

  return { merged: m, fractals: fs, strokes: st, sl, segs, pivots: pv, div: dv, sig, signals: sig, md, mi };
}
