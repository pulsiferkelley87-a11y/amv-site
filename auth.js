/* ===== 站点登录闸门（前端可见性控制）=====
 * 账号由管理员预先开通并写入 accounts.json；密码只存 PBKDF2-SHA256 哈希。
 * 登录成功后在浏览器保存会话票据，其它页面据此放行 / 拦截。
 */
(function (g) {
  "use strict";

  const ACCOUNTS_URL = "accounts.json";
  const ITER_DEFAULT = 120000;
  const SESSION_KEY = "amv_session_v1";
  const LOGIN_PAGE = "login.html";

  /* ---------- 编码工具 ---------- */
  const enc = new TextEncoder();

  function hexToBuf(hex) {
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  }

  function bufToHex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function randomHex(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return bufToHex(a);
  }

  /* ---------- 哈希 ---------- */
  async function pbkdf2(password, saltHex, iter) {
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: iter || ITER_DEFAULT, hash: "SHA-256" },
      key, 256
    );
    return bufToHex(bits);
  }

  async function sha256(text) {
    const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
    return bufToHex(d);
  }

  /* ---------- 账号表 ---------- */
  let _cache = null;

  async function loadAccounts(force) {
    if (_cache && !force) return _cache;
    const r = await fetch(ACCOUNTS_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("accounts.json 读取失败：" + r.status);
    _cache = await r.json();
    return _cache;
  }

  function findUser(acc, name) {
    const u = (name || "").trim().toLowerCase();
    return (acc.users || []).find((x) => String(x.u).toLowerCase() === u) || null;
  }

  /* ---------- 会话 ---------- */
  function readSession(storage) {
    try {
      const raw = (storage || g.localStorage).getItem(SESSION_KEY) || g.sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeSession(s, remember) {
    const raw = JSON.stringify(s);
    if (remember) g.localStorage.setItem(SESSION_KEY, raw);
    else g.sessionStorage.setItem(SESSION_KEY, raw);
  }

  function clearSession() {
    g.localStorage.removeItem(SESSION_KEY);
    g.sessionStorage.removeItem(SESSION_KEY);
  }

  async function makeSession(user, remember) {
    const exp = Date.now() + (remember ? 7 * 864e5 : 12 * 36e5);
    const sig = (await sha256([user.u, exp, user.hash].join("|"))).slice(0, 24);
    return { u: user.u, r: user.role || "user", x: exp, g: sig, m: !!remember };
  }

  async function sessionValid(s, acc) {
    if (!s || !s.u || !s.x || s.x < Date.now()) return false;
    const u = findUser(acc, s.u);
    if (!u) return false;
    const sig = (await sha256([u.u, s.x, u.hash].join("|"))).slice(0, 24);
    return sig === s.g;
  }

  /* ---------- 登录 / 登出 ---------- */
  async function login(name, password, remember) {
    const acc = await loadAccounts(true);
    const u = findUser(acc, name);
    if (!u) return { ok: false, msg: "这个账号还没有开通，请联系管理员" };
    const h = await pbkdf2(password, u.salt, u.iter);
    if (h !== u.hash) return { ok: false, msg: "密码不对" };
    const s = await makeSession(u, remember);
    writeSession(s, remember);
    return { ok: true, user: { u: u.u, r: u.role || "user" } };
  }

  function logout() {
    clearSession();
    const next = encodeURIComponent(location.pathname.split("/").pop() + (location.hash || ""));
    location.replace(LOGIN_PAGE + "?next=" + next);
  }

  /* ---------- 闸门 ---------- */
  const EXEMPT = ["login.html", "admin.html"];

  function currentPage() {
    return (location.pathname.split("/").pop() || "index.html").toLowerCase();
  }

  function guard() {
    if (EXEMPT.indexOf(currentPage()) >= 0) return;
    const s = readSession();
    if (!s || !s.x || s.x < Date.now()) return kick();
    // 先放行（避免闪烁），随后异步校验签名，失败再踢
    verifyThen();
    return;
  }

  async function verifyThen() {
    try {
      const acc = await loadAccounts();
      const s = readSession();
      if (!(await sessionValid(s, acc))) { clearSession(); kick(); }
    } catch (e) {
      // 账号表取不到时不锁死页面，仅提示
      console.warn("[auth]", e.message);
    }
  }

  function kick() {
    const next = encodeURIComponent(location.pathname.split("/").pop() + (location.hash || ""));
    location.replace(LOGIN_PAGE + "?next=" + next);
  }

  /* ---------- 管理员：生成账号条目 ---------- */
  async function grant(name, password, opts) {
    const iter = ITER_DEFAULT;
    const salt = randomHex(16);
    const hash = await pbkdf2(password, salt, iter);
    return {
      u: name.trim(),
      role: (opts && opts.role) || "user",
      salt, hash, iter,
      note: (opts && opts.note) || "",
      created: new Date().toISOString().slice(0, 19).replace("T", " "),
    };
  }

  /* ---------- 管理员：写回 GitHub ---------- */
  async function saveToGitHub(pat, owner, repo, branch, accounts) {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/accounts.json`;
    const headers = { Authorization: "Bearer " + pat, Accept: "application/vnd.github+json" };
    let sha = null;
    const cur = await fetch(api + "?ref=" + encodeURIComponent(branch || "main"), { headers });
    if (cur.ok) { const j = await cur.json(); sha = j.sha; }
    const text = JSON.stringify(accounts, null, 2);
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const body = {
      message: "chore(auth): 更新账号表（" + new Date().toISOString().slice(0, 10) + "）",
      content: b64, branch: branch || "main",
    };
    if (sha) body.sha = sha;
    const put = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!put.ok) throw new Error("写入失败 " + put.status + " " + (await put.text()).slice(0, 120));
    return true;
  }

  /* ---------- 小挂件：右下角身份 / 退出 ---------- */
  async function badge() {
    const s = readSession();
    if (!s || !s.u) return;
    const el = document.createElement("div");
    el.id = "authChip";
    el.innerHTML =
      '<span class="au">' + s.u + (s.r === "admin" ? " · 管理员" : "") + "</span>" +
      '<a href="javascript:void 0" class="out">退出</a>';
    el.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:9998;display:flex;gap:8px;align-items:center;" +
      "padding:6px 10px;border-radius:999px;font:12px/1.4 system-ui,-apple-system,'PingFang SC',sans-serif;" +
      "background:rgba(15,23,42,.82);color:#cbd5e1;border:1px solid rgba(148,163,184,.28);" +
      "backdrop-filter:blur(6px);box-shadow:0 6px 18px rgba(0,0,0,.35)";
    el.querySelector(".out").style.cssText = "color:#7dd3fc;text-decoration:none";
    el.querySelector(".out").onclick = logout;
    document.body.appendChild(el);
  }

  g.AUTH = {
    guard, login, logout, session: readSession, badge,
    loadAccounts, findUser, grant, saveToGitHub, pbkdf2, sha256, randomHex,
    clearSession, isValid: sessionValid,
  };
})(window);
