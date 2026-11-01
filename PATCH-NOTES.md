# 本次改动说明（PATCH-NOTES）

时间：2026-11-01 23:12
范围：`F:\小太阳的聊天记录\amv-cloud\`（当前线上真源）

---

## 一、先说清这个文件夹让我确认了什么

在此之前我只有 GitHub 上的克隆。这个工作区补齐了全貌：

| 目录 | 角色 | 结论 |
|---|---|---|
| `amv-site/` | 本地开发版（含 `.venv`、`serve.py`、定时任务脚本） | 页面已过期：`app.js` 56.3 KB，`app-data.js` 4.8 MB |
| `amv-cloud/` | **线上真源**（GitHub API 增量上传 + Pages 部署） | `app21.js` 62.1 KB，`app-data.js` 9.5 MB，10-29 更新 |
| `compass-0amv-extractor/` | 指南针 0AMV 提取管线（Python 包，含 docs/tests） | 核心数据来源，独立工程 |
| `compass-0amv-output/` | 提取产物（`0amv_daily.csv`、`znz0_daily.csv` 等） | 10-30 最新 |
| `tdxclaw-migration/`、`zxg-analysis/`、`点将台-v1.0.0/` | 其他项目 | 与本站无关 |

关键验证：**三代 `index.html` 字节完全相同**（`FD627BAECE7B`，14,744 B），
所以我对页面做的补丁对线上同样成立。

同时确认了两条我没料到的链路：

1. `deploy.yml` 用 `path: '.'` 把**整个仓库根**当 Pages 产物 → 463 MB 构建输入被全额发布。
2. `upload_frontend.py` 有**硬编码上传清单**，新文件不加进去就永远不会出现在仓库里。

---

## 二、我改了什么

### 已写入 `amv-cloud\`

| 文件 | 动作 | 说明 |
|---|---|---|
| `index.html` | **已替换**（14,744 → 17,158 B） | 原文件备份为 `index.html.bak-20261101-231213` |
| `realtime-quote.js` | 新增 | 实时行情模块，43 项单测通过 |
| `live-quote-bar.js` | 新增 | 顶部行情条，**纯附加**，不改 `app21.js` |
| `favicon.svg` | 新增 | 原创图标 |
| `robots.txt` | 新增 | 屏蔽 28 个历史快照 + 指向 sitemap |
| `sitemap.xml` | 新增 | 只收录首页与 `live.html` |
| `404.html` | 新增 | 品牌化错误页 |
| `.nojekyll` | 新增 | 跳过 Jekyll |
| `index2.html` | **已替换**（11,769 → 1,666 B） | 旧版首页快照 → 跳转页；备份为 `index2.html.bak-20261101-232347` |
| `robots.txt` | 追加 | `Disallow: /index2.html`、`Disallow: /diag_kline.html` |
| `deploy.patch.yml` | 新增 | 部署脚本改法（含逐条理由与检查清单） |

### `index.html` 的 10 处改动

1. 补 `description` / `keywords` / `robots` / `canonical`
2. 补 Open Graph 与 Twitter Card
3. 补 `favicon.svg` / `apple-touch-icon` / `manifest.json` 引用
4. 补 `theme-color`（明暗两套）与 `color-scheme`
5. 删掉两条无效的 `http-equiv` 缓存 meta
6. `echarts.min.js` → `defer`（不再阻塞首屏）
7. 脚本 `?v=` 时间戳 → 固定 `BUILD_ID = "20261101a"`
8. 主题按钮补 `aria-label` / `aria-pressed`
9. 加 `skip-link` + 主内容 `id="main"` + `<noscript>` 提示
10. 修掉重复的 `</style></style>`
11. 末尾挂载 `realtime-quote.js` 与 `live-quote-bar.js`

回滚只需：

```powershell
Copy-Item index.html.bak-20261101-231213 index.html -Force
```

---

## 三、还必须由你做的两步（否则上面都不生效）

### 1️⃣ 把新文件加进上传清单

`upload_frontend.py` 第 94 行 `targets = [...]` 里追加：

```python
    targets = ["app.js", "index.html", "app-data.js", "app-data.js.gz", "d2.js.gz", "echarts.min.js",
               "live.html", "live_data.json",
               # ↓ 本次新增
               "realtime-quote.js", "live-quote-bar.js",
               "favicon.svg", "robots.txt", "sitemap.xml", "404.html", ".nojekyll",
               "index2.html",          # ← 跳转页也必须上传，否则线上还是旧快照
               "manifest.json",        # ← index.html 引用了它，漏传就是 404
               "scripts/update_cloud.py", "scripts/news_update.py",
               ...
```

不加这一段，文件只在你本地，仓库和线上都不会有。

### 2️⃣ 改 `deploy.yml` 的发布路径

按 `deploy.patch.yml` 替换 `upload-pages-artifact` 那一段。
**注意别写 `--exclude 'app*.js'`**——页面加载的正是 `app21.js`，会被一起排掉导致白屏。

---

## 四、独立复查结果（2026-11-02，HanaAgent 交割）

通过交接台把改动交给另一个 agent 平台独立复查，收到 6 条 findings。
**我逐条验证后：4 条成立并已修，1 条说错，1 条是既有问题。**

| # | 复查意见 | 我的验证 | 处置 |
|---|---|---|---|
| 1 | `deploy.patch.yml` 里 `--exclude 'index2.html'` 与「上传跳转页」自相矛盾 | **成立**：第 52 行确实有这行，按 patch 部署后 `/index2.html` 直接 404，跳转页白做 | ✅ 已删除该排除行 |
| 2 | `index.html` 的 `<style>` 未配平（3 开 2 闭） | **成立，而且是我改出来的**：原文件 `</style></style>` 是**正确**的双闭合（两个 style 块），我当成重复标签删掉了一个 | ✅ 已补回 `</style>`，现 3 开 3 闭 |
| 3 | `apple-touch-icon` 用了 SVG，应改 `icon.png`，「仓库里已有 icon.png」 | **半错**：SVG 确实不被 iOS 支持，但**仓库里没有任何 PNG**（复查凭空说存在） | ✅ 已删掉该行，避免死引用；要 iOS 图标需另生成 180×180 PNG |
| 4 | `manifest.json` 没进上传清单，线上会 404 | **成立**：`upload_frontend.py` 里搜不到 manifest.json | ✅ 已加入清单说明 |
| 5 | 旧浏览器（无 `DecompressionStream`）下主图表可能白屏 | **成立，且是既有问题**：`app21.js` 先于 `app-data.js` 执行，`window.DATA` 未定义即 return | ⚠️ 本次未引入也未修复，复查已标「未验证」，记在此处跟踪 |
| 6 | rsync 缺 `--exclude '_site'`，本地重复跑会嵌套复制 | **成立** | ✅ 已补该行 |

### 这次复查对我的实际价值

第 2 条是我自己引入的回归——我为了"修掉重复闭合标签"反而破坏了结构，
而且我当时的自检脚本只查"是否还存在 `</style></style>`"，没查配平，
所以绿灯放行。**自检的判据选错了，比没有自检更危险。**

教训：结构性改动必须验证**不变量**（开合数量相等），而不是验证"坏样式是否消失"。

---

## 五、第二轮复查（2026-11-02，旧浏览器 boot 修复）

针对「旧浏览器主图表白屏」的修法（boot 顺序对调）单独复查，结果 **0 条必须改、2 条建议**。

### 复查确认（我核对一致）

| 检查点 | 结论 |
|---|---|
| 现代浏览器分支是否被改动 | 否，仍只写 `app21.js`，BUILD_ID 与改前一致 |
| `app21.js` 是否还依赖 `app-data.js` 的其他全局 | 否，全文 `window.*` 只有 `window.DATA`（59/1381/1395/1396）+ 自有 `window._rangeAgg` |
| `var DATA` 是否成为 `window.DATA` | 是，经典脚本顶层 `var`，非块级、非 IIFE 包裹 |
| 是否引入新时序问题 | 否，解析期顶层只有 `load()`/`loadBullBear()`/`refreshCharts` 赋值/两个 `setInterval` |
| 缺口是否闭合 | 闭合（旧浏览器 data 先同步执行完 → DATA 就绪 → load() 正常走） |

### 它挑出的两条

**① `load()` 缺少 gz 失败回退（已修）**

现代浏览器若 `d2.js.gz` 拉取失败，`load()` 里 `D` 为空、`window.DATA` 又没写（`app-data.js` 未加载）→ 直接 `return`，
主图表白屏最多 10 分钟等 `autoRefreshData` 兜底。而 `refreshAll` 有完整回退链，`load()` 没有。

我核对属实，并做了修复：

```js
if (!D) D = window.DATA;
if (!D) {
  if (!window.__amvLoadFallback) {          // 只试一次，避免失败风暴
    window.__amvLoadFallback = true;
    loadDataScript(function () { D = window.DATA; load(); }, function () {});
  }
  return;
}
```

依据：`d2.js.gz` 与 `app-data.js.gz` **字节完全相同**（SHA-256 均 `02D6E253…`，同为 2,335,288 B），
故回退到 `app-data.js` 语义等价；`loadDataScript` 是函数声明会提升，在 `load()` 内可调。
备份 `app21.js.bak-20261102-001441`，`node --check` 通过。**未在浏览器验证。**

**② 部署缓存提醒（未改代码）**

`index.html` 本身不受 `BUILD_ID` 管控，靠 HTTP 缓存。上线后旧的 boot 顺序可能仍被命中一段时间，
修复在你的手机上未必立刻生效——建议部署后切流量/清缓存，或等缓存自然过期。

---

## 六、第三轮复查（2026-11-02，app21.js 回退补丁）

唯一动到核心业务文件（62 KB）的改动，单独送检。**裁决：keep**（无必须改，2 条 info）。

### 复查确认（我已独立核验）

| 检查点 | 结论 |
|---|---|
| 补丁位置 | 仅在 `load()` 内，注入点在 `if (!D) D = window.DATA` 之后、渲染链之前；`D` 非空时整块滑过 |
| 递归安全 | 一次性标记 + onload 先赋值再 `load()`；第二次进入 `D` 非空即渲染；若 DATA 仍空则标记已置、不再注入 → 必然终止，渲染只触发一次 |
| `document.body` 时序 | 安全。且补充了我先前没想到的一点：回退分支只在 `DecompressionStream` 存在且 gz 失败时可达，那时已在 `await fetch` 之后，解析必已推进 |
| 共享状态 | `__amvLoadFallback` 全文仅第 63/64 行读写（我 grep 复核一致），无同名冲突 |
| 失败语义 | `onerror` 空函数静默，不打断顶层独立的 `loadBullBear()`，交 10 分钟轮询兜底 |
| 数据等价性 | 它引用的 SHA-256 `02D6E253…2EE5` 与我实测完全一致，`d2.js.gz` 与 `app-data.js.gz` 同哈希同尺寸 |

### 两条 info 级意见及我的处置

**① 可选优化：回退时 `load()` 会重试一次刚失败的 `d2.js.gz`（浪费一个往返）**

**不采纳。** 理由：`load()` 只有两个调用点（第 65 行回退、第 1463 行顶层），改签名要同时动两处，
而收益仅是"罕见失败路径上省一次请求"。为这点收益再去改核心文件、再走一轮复查，
在无法浏览器实测的前提下风险收益不划算。复查自己也写了"不改也可上线"。

**② 行为提醒：回退注入的 `app-data.js` 可能与 `autoRefreshData` 的注入叠加（重执行 9.5 MB）**

不改，修前既有行为，无逻辑冲突。

---

## 七、边界

- **没有推送**：我没有仓库写权限，所有改动都在本地工作区，需要你跑 `upload_frontend.py`。
- **没有在浏览器验证**：行情条依赖 `<script>` 加载腾讯 `qt.gtimg.cn`（绕 CORS）与 GBK 解码，
  逻辑与解析已单测，但真实渲染效果请打开页面确认；如异常，`live-quote-bar.js` 会在控制台
  打印 `[rt-bar]` 前缀的日志，删掉那两个 `<script>` 标签即可完全恢复原状。
- **没有动 `app21.js`**：行情条走独立节点，不依赖也不修改它的内部状态。
- **没有评价模型**：0AMV 递推（`A_t = D·A_{t-1} + min(换手率/1.1,1)·(1−A_{t-1})`，`D = 0.5^(1.25/10)`）、
  六维评分、回测数字均未审阅。
