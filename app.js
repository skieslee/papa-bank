/* ====================================================================
   爸爸銀行 papa-bank — 主程式（純 JavaScript，無需安裝）
   功能：存/提款、明細(分頁)、年息自動配息、多存款人、
        小數位數、每月趨勢圖、每月收支、中英切換、家長唯讀鎖、
        本機 / Firebase 雲端同步雙模式。
   ==================================================================== */
(function () {
  "use strict";

  var STORAGE_KEY = "papa-bank-state-v1";
  var LANG_KEY = "papa-bank-lang";     // 裝置本地（每個人可選自己的語言）
  var AUTO_LOCK_MS = 3 * 60 * 1000;    // 爸爸模式閒置多久自動回兒童模式
  var MAX_ACCRUE = 5000;
  var PAGE_SIZE = 8;
  var MAX_ACCOUNTS = 20;        // 存款人上限
  var MAX_AMOUNT = 1e9;         // 單筆金額上限（10 億）
  var MAX_RATE_PCT = 1000;      // 年息上限（%）
  var MONTHS_WINDOW = 24;       // 趨勢圖 / 每月收支最多顯示月數
  var NAME_MAX = 20, NOTE_MAX = 40; // 文字長度上限

  var PERIODS = {
    minute: { ms: 60 * 1000,                divisor: 12 },
    day:    { ms: 24 * 60 * 60 * 1000,      divisor: 365 },
    month:  { ms: 30 * 24 * 60 * 60 * 1000, divisor: 12 }
  };

  var state = null;
  var store = null;
  var isCloud = false;
  var applyingRemote = false;
  var historyPage = 0;
  var parentMode = false;        // 只存記憶體：重新整理 / 重開都會回到兒童模式
  var lastActivity = Date.now(); // 給「閒置自動上鎖」用

  // ================= i18n =================
  function getLang() {
    var l = null;
    try { l = localStorage.getItem(LANG_KEY); } catch (e) {}
    return (l === "en") ? "en" : "zh";
  }
  function setLang(l) { try { localStorage.setItem(LANG_KEY, l); } catch (e) {} }
  function t(key) {
    var d = I18N[getLang()] || I18N.zh;
    var v = d[key];
    if (v == null) v = I18N.zh[key];
    if (typeof v === "function") return v.apply(null, [].slice.call(arguments, 1));
    return v == null ? key : v;
  }

  // ================= 資料模型 =================
  function defaultState() {
    return { version: 2, interestPeriod: "month", decimals: 2, parentPin: "", accounts: [], activeAccountId: null };
  }
  function migrate() {
    if (!state || typeof state !== "object") state = defaultState();
    if (!PERIODS[state.interestPeriod]) state.interestPeriod = "month";
    if ([0, 1, 2].indexOf(state.decimals) < 0) state.decimals = 2;
    if (typeof state.parentPin !== "string") state.parentPin = "";
    if (!Array.isArray(state.accounts)) state.accounts = [];
    state.accounts.forEach(function (a) {
      if (!Array.isArray(a.transactions)) a.transactions = [];
      if (typeof a.rateAnnual !== "number" || !isFinite(a.rateAnnual)) a.rateAnnual = 0;
      if (typeof a.goalAmount !== "number" || !isFinite(a.goalAmount)) a.goalAmount = 0;
      if (typeof a.name !== "string") a.name = "?";
    });
    if (!findAccount(state.activeAccountId)) state.activeAccountId = state.accounts.length ? state.accounts[0].id : null;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function findAccount(id) {
    for (var i = 0; i < state.accounts.length; i++) if (state.accounts[i].id === id) return state.accounts[i];
    return null;
  }
  function activeAccount() { return findAccount(state.activeAccountId); }
  function balanceOf(acc) {
    var b = 0;
    for (var i = 0; i < acc.transactions.length; i++) {
      var x = acc.transactions[i];
      b += (x.type === "withdraw") ? -x.amount : x.amount;
    }
    return roundTo(b, 4);
  }

  // ================= 數字 / 格式 =================
  function roundTo(x, d) { var f = Math.pow(10, d); return Math.round(x * f) / f; }
  function nf(n) {
    var d = state ? state.decimals : 0;
    return Number(n).toLocaleString(getLang() === "en" ? "en-US" : "zh-Hant",
      { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function money(n) { return "NT$" + nf(n); }
  function fmtDate(ts) {
    var d = new Date(ts), pad = function (x) { return (x < 10 ? "0" : "") + x; };
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function ymKey(ts) { var d = new Date(ts); return d.getFullYear() + "-" + (d.getMonth() + 1); }
  function monthLabel(key) {
    var p = key.split("-");
    return getLang() === "en" ? (p[1] + "/" + String(p[0]).slice(2)) : (p[0] + "/" + p[1]);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  // 解析有效金額：> 0、有限數、不超過上限；否則回傳 NaN（無效）或 Infinity（太大）
  function validAmount(raw) {
    var n = roundTo(parseFloat(raw), state.decimals);
    if (!isFinite(n) || n <= 0) return NaN;
    if (n > MAX_AMOUNT) return Infinity;
    return n;
  }
  // 把使用者輸入的金額夾在 [0, 上限]，無效則回傳 0
  function clampAmount(raw) {
    var n = roundTo(parseFloat(raw), state.decimals);
    if (!isFinite(n) || n < 0) return 0;
    return n > MAX_AMOUNT ? MAX_AMOUNT : n;
  }
  function clampRatePct(raw) {
    var n = parseFloat(raw);
    if (!isFinite(n) || n < 0) return 0;
    return n > MAX_RATE_PCT ? MAX_RATE_PCT : n;
  }
  function safeParse(raw, fallback) {
    try { var o = JSON.parse(raw); return (o && typeof o === "object") ? o : fallback; }
    catch (e) { return fallback; }
  }
  function pad2(x) { return (x < 10 ? "0" : "") + x; }
  function fmtDateFull(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function ymd() { var d = new Date(); return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }
  function safeFilename(s) { return String(s).replace(/[\\\/:*?"<>|\s]/g, "_"); }

  // ================= 匯出 / 備份 / 還原 =================
  function downloadFile(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }
  function csvCell(v) {
    v = String(v == null ? "" : v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCSV() {
    var acc = activeAccount(); if (!acc) return;
    var txs = acc.transactions.slice().sort(function (a, b) { return a.ts - b.ts; });
    var run = 0;
    var rows = [[t("hDate"), t("hType"), t("hAmount"), t("hNote"), t("hBalance")]];
    txs.forEach(function (x) {
      run += (x.type === "withdraw") ? -x.amount : x.amount;
      var typeLabel = x.type === "deposit" ? t("noteDeposit") : x.type === "withdraw" ? t("noteWithdraw") : t("noteInterest");
      var amt = (x.type === "withdraw" ? "-" : "") + x.amount;
      rows.push([fmtDateFull(x.ts), typeLabel, amt, x.note || "", roundTo(run, state.decimals)]);
    });
    var BOM = String.fromCharCode(0xFEFF); // Excel 需要 BOM 才能正確顯示中文
    var csv = BOM + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    downloadFile("papa-bank-" + safeFilename(acc.name) + "-" + ymd() + ".csv", csv, "text/csv");
    toast(t("exported"));
  }
  function exportBackup() {
    downloadFile("papa-bank-backup-" + ymd() + ".json", JSON.stringify(state, null, 2), "application/json");
    toast(t("exported"));
  }
  function restoreBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data = safeParse(reader.result, null);
      if (!data || !Array.isArray(data.accounts)) { toast(t("restoreFail")); return; }
      if (!confirm(t("restoreConfirm"))) return;
      state = data; migrate(); historyPage = 0; save(); closeModal(); toast(t("restored"));
    };
    reader.readAsText(file);
  }

  // ================= 利息 =================
  function accrueInterest() {
    var now = Date.now();
    var p = PERIODS[state.interestPeriod] || PERIODS.month;
    var changed = false, credited = 0;
    for (var i = 0; i < state.accounts.length; i++) {
      var acc = state.accounts[i];
      if (!acc.lastInterestAt) acc.lastInterestAt = acc.createdAt || now;
      var ratePerPeriod = (acc.rateAnnual || 0) / p.divisor;
      var guard = 0;
      while (now - acc.lastInterestAt >= p.ms && guard < MAX_ACCRUE) {
        guard++;
        var interest = roundTo(balanceOf(acc) * ratePerPeriod, state.decimals);
        acc.lastInterestAt += p.ms;
        if (interest > 0) {
          acc.transactions.push({ id: uid(), type: "interest", amount: interest, note: t("noteInterest"), ts: acc.lastInterestAt });
          credited += interest; changed = true;
        }
      }
      if (now - acc.lastInterestAt >= p.ms) acc.lastInterestAt = now;
    }
    return { changed: changed, credited: roundTo(credited, state.decimals) };
  }
  function nextInterestText(acc) {
    var p = PERIODS[state.interestPeriod] || PERIODS.month;
    if (!acc || !(acc.rateAnnual > 0)) return t("rateUnset");
    var remain = p.ms - (Date.now() - (acc.lastInterestAt || Date.now()));
    if (remain < 0) remain = 0;
    if (state.interestPeriod === "minute") return t("nextSec", Math.max(1, Math.ceil(remain / 1000)));
    if (state.interestPeriod === "day")    return t("nextHour", Math.max(1, Math.ceil(remain / 3600000)));
    return t("nextDay", Math.max(1, Math.ceil(remain / 86400000)));
  }

  // ================= 動作 =================
  function addAccount(name, rateAnnual, goalName, goalAmount) {
    var now = Date.now();
    var acc = { id: uid(), name: name, rateAnnual: rateAnnual, goalName: goalName || "", goalAmount: goalAmount || 0,
                createdAt: now, lastInterestAt: now, transactions: [] };
    state.accounts.push(acc);
    state.activeAccountId = acc.id;
    historyPage = 0;
    save();
  }
  function doDeposit(acc, amount, note) {
    acc.transactions.push({ id: uid(), type: "deposit", amount: amount, note: note, ts: Date.now() });
    historyPage = 0; save(); toast(t("deposited", money(amount)));
  }
  function doWithdraw(acc, amount, note) {
    acc.transactions.push({ id: uid(), type: "withdraw", amount: amount, note: note, ts: Date.now() });
    historyPage = 0; save(); toast(t("withdrew", money(amount)));
  }

  // ================= 模式：預設兒童（唯讀），認證後才是爸爸模式 =================
  function isParent() { return parentMode; }
  function enterParent() { parentMode = true; lastActivity = Date.now(); }
  function leaveParent() { parentMode = false; }

  // ================= 渲染 =================
  function applyStaticI18n() {
    document.documentElement.lang = getLang() === "en" ? "en" : "zh-Hant";
    document.getElementById("brand-text").textContent = t("brand");
    document.getElementById("balance-label").textContent = t("balanceLabel");
    document.getElementById("deposit-btn").textContent = t("deposit");
    document.getElementById("withdraw-btn").textContent = t("withdraw");
    document.getElementById("trend-title").textContent = t("trendTitle");
    document.getElementById("monthly-title").textContent = t("monthlyTitle");
    document.getElementById("history-title").textContent = t("historyTitle");
    document.getElementById("lang-btn").textContent = getLang() === "en" ? "EN" : "中";
    document.getElementById("mode-badge").textContent = isCloud ? t("modeCloud") : t("modeLocal");
    // 登入畫面
    document.getElementById("login-brand").textContent = t("brand");
    document.getElementById("login-hint").textContent = t("loginHint");
    document.getElementById("login-pw").placeholder = t("pwPlaceholder");
    document.getElementById("login-btn").textContent = t("loginBtn");
  }

  function render() {
    if (!state) return;
    applyStaticI18n();
    applyModeUI();
    renderTabs();
    renderBalance();
    renderGoal();
    renderChart();
    renderMonthly();
    renderHistory();
  }

  function applyModeUI() {
    var p = isParent();
    var lb = document.getElementById("lock-btn");
    lb.textContent = p ? "🔓" : "🔒";
    lb.title = p ? t("parentMode") : t("childMode");
    document.getElementById("deposit-btn").style.display = p ? "" : "none";
    document.getElementById("withdraw-btn").style.display = p ? "" : "none";
    document.getElementById("settings-btn").style.display = p ? "" : "none";
  }

  function renderTabs() {
    var tabs = document.getElementById("tabs");
    tabs.innerHTML = "";
    state.accounts.forEach(function (acc) {
      var b = document.createElement("button");
      b.className = "tab" + (acc.id === state.activeAccountId ? " active" : "");
      b.textContent = acc.name;
      b.onclick = function () { state.activeAccountId = acc.id; historyPage = 0; save(); };
      tabs.appendChild(b);
    });
    if (isParent() && state.accounts.length < MAX_ACCOUNTS) {
      var add = document.createElement("button");
      add.className = "tab add";
      add.textContent = t("addPerson");
      add.onclick = openAddAccount;
      tabs.appendChild(add);
    }
  }

  function renderBalance() {
    var acc = activeAccount();
    var balEl = document.getElementById("balance"),
        rateEl = document.getElementById("rate-pill"),
        nextEl = document.getElementById("next-interest");
    if (!acc) {
      balEl.textContent = money(0);
      rateEl.textContent = isParent() ? t("pickPersonFirst") : t("childNoData");
      nextEl.textContent = "";
      return;
    }
    balEl.textContent = money(balanceOf(acc));
    rateEl.textContent = t("rate", +(acc.rateAnnual * 100).toFixed(2));
    nextEl.textContent = nextInterestText(acc);
  }

  function renderGoal() {
    var acc = activeAccount();
    var el = document.getElementById("goal");
    if (!acc || !(acc.goalAmount > 0)) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    var bal = balanceOf(acc);
    var pct = Math.max(0, Math.min(100, Math.round(bal / acc.goalAmount * 100)));
    var done = bal >= acc.goalAmount;
    var remain = roundTo(acc.goalAmount - bal, state.decimals);
    el.classList.remove("hidden");
    el.innerHTML =
      '<div class="goal-top"><span>' + escapeHtml(t("goalLabel", acc.goalName || "", money(acc.goalAmount))) + "</span>" +
      "<span>" + (done ? t("goalDone") : t("goalRemain", money(remain), pct)) + "</span></div>" +
      '<div class="goal-track"><div class="goal-fill' + (done ? " done" : "") + '" style="width:' + pct + '%"></div></div>';
  }

  // 每月：累積月底餘額（給趨勢圖）與每月收支
  function monthSeries(acc) {
    if (acc.transactions.length === 0) return { keys: [], balances: [], stats: {} };
    var txs = acc.transactions.slice().sort(function (a, b) { return a.ts - b.ts; });
    var first = new Date(txs[0].ts), now = new Date();
    // 用「絕對月份序號」計算，並限制成最近 MONTHS_WINDOW 個月，避免列表無限長或時間戳異常時暴增
    var firstIdx = first.getFullYear() * 12 + first.getMonth();
    var nowIdx = now.getFullYear() * 12 + now.getMonth();
    if (nowIdx < firstIdx) nowIdx = firstIdx; // 防呆：交易在未來
    var startIdx = Math.max(firstIdx, nowIdx - (MONTHS_WINDOW - 1));
    var keys = [], stats = {};
    for (var idx = startIdx; idx <= nowIdx; idx++) {
      var key = Math.floor(idx / 12) + "-" + ((idx % 12) + 1);
      keys.push(key);
      stats[key] = { in: 0, interest: 0, out: 0, end: 0 };
    }
    // 每月收支
    txs.forEach(function (x) {
      var s = stats[ymKey(x.ts)];
      if (!s) return;
      if (x.type === "deposit") s.in += x.amount;
      else if (x.type === "interest") s.interest += x.amount;
      else s.out += x.amount;
    });
    // 月底累積餘額
    var balances = keys.map(function (key) {
      var p = key.split("-"), end = new Date(+p[0], +p[1], 1).getTime();
      var b = 0;
      for (var i = 0; i < txs.length; i++) {
        if (txs[i].ts < end) b += (txs[i].type === "withdraw") ? -txs[i].amount : txs[i].amount;
      }
      b = roundTo(b, state.decimals);
      stats[key].end = b;
      return b;
    });
    return { keys: keys, balances: balances, stats: stats };
  }

  function renderChart() {
    var acc = activeAccount();
    var el = document.getElementById("chart");
    if (!acc) { el.innerHTML = '<div class="empty">' + t("notEnoughData") + "</div>"; return; }
    var ser = monthSeries(acc);
    if (ser.keys.length < 2) { el.innerHTML = '<div class="empty">' + t("notEnoughData") + "</div>"; return; }

    var W = 320, H = 150, padL = 8, padR = 8, padT = 14, padB = 22;
    var vals = ser.balances;
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals.concat([0]));
    if (max === min) max = min + 1;
    var n = vals.length;
    var x = function (i) { return padL + (W - padL - padR) * (n === 1 ? 0.5 : i / (n - 1)); };
    var yv = function (v) { return padT + (H - padT - padB) * (1 - (v - min) / (max - min)); };

    var pts = vals.map(function (v, i) { return x(i) + "," + yv(v); }).join(" ");
    var area = "M" + x(0) + "," + yv(min) + " L" + pts.split(" ").join(" L") + " L" + x(n - 1) + "," + yv(min) + " Z";

    // x 軸標籤：最多顯示約 6 個，避免擁擠
    var step = Math.ceil(n / 6);
    var labels = "";
    for (var i = 0; i < n; i++) {
      if (i % step === 0 || i === n - 1) {
        var anchor = i === 0 ? "start" : (i === n - 1 ? "end" : "middle");
        labels += '<text x="' + x(i) + '" y="' + (H - 6) + '" class="ax" text-anchor="' + anchor + '">' + monthLabel(ser.keys[i]) + "</text>";
      }
    }
    var dots = vals.map(function (v, i) { return '<circle cx="' + x(i) + '" cy="' + yv(v) + '" r="2.6" class="dot"/>'; }).join("");
    var lastLabel = '<text x="' + x(n - 1) + '" y="' + (yv(vals[n - 1]) - 7) + '" class="val" text-anchor="end">' + nf(vals[n - 1]) + "</text>";

    el.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet" class="chart-svg">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="var(--primary)" stop-opacity="0.28"/>' +
      '<stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#g)"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + labels + lastLabel + "</svg>";
  }

  function renderMonthly() {
    var acc = activeAccount();
    var el = document.getElementById("monthly");
    if (!acc || acc.transactions.length === 0) { el.innerHTML = '<div class="empty">—</div>'; return; }
    var ser = monthSeries(acc);
    var head =
      '<div class="m-row m-head"><span>' + t("colMonth") + "</span><span>" + t("colIn") +
      "</span><span>" + t("colInterest") + "</span><span>" + t("colOut") + "</span><span>" + t("colNet") + "</span></div>";
    var rows = ser.keys.slice().reverse().map(function (key) {
      var s = ser.stats[key];
      var net = roundTo(s.in + s.interest - s.out, state.decimals);
      var netCls = net > 0 ? "plus" : net < 0 ? "minus" : "";
      var netStr = (net > 0 ? "+" : net < 0 ? "−" : "") + nf(Math.abs(net));
      return '<div class="m-row">' +
        "<span>" + monthLabel(key) + "</span>" +
        '<span class="plus">' + (s.in ? "+" + nf(s.in) : "—") + "</span>" +
        '<span class="interest">' + (s.interest ? "+" + nf(s.interest) : "—") + "</span>" +
        '<span class="minus">' + (s.out ? "−" + nf(s.out) : "—") + "</span>" +
        '<span class="' + netCls + '">' + netStr + "</span></div>";
    }).join("");
    el.innerHTML = head + rows;
  }

  function renderHistory() {
    var acc = activeAccount();
    var list = document.getElementById("history-list");
    var empty = document.getElementById("history-empty");
    var pager = document.getElementById("pager");
    list.innerHTML = "";
    empty.textContent = t("emptyHistory");
    if (!acc || acc.transactions.length === 0) {
      empty.classList.remove("hidden"); pager.classList.add("hidden"); return;
    }
    empty.classList.add("hidden");

    var sorted = acc.transactions.slice().sort(function (a, b) { return a.ts - b.ts; });
    var running = 0;
    sorted.forEach(function (tx) { running += (tx.type === "withdraw") ? -tx.amount : tx.amount; tx._bal = roundTo(running, state.decimals); });
    sorted.reverse(); // 新→舊

    var totalPages = Math.ceil(sorted.length / PAGE_SIZE);
    if (historyPage > totalPages - 1) historyPage = totalPages - 1;
    if (historyPage < 0) historyPage = 0;
    var pageItems = sorted.slice(historyPage * PAGE_SIZE, historyPage * PAGE_SIZE + PAGE_SIZE);

    pageItems.forEach(function (tx) {
      var li = document.createElement("li");
      li.className = "history-item";
      var icon = tx.type === "deposit" ? "💰" : tx.type === "withdraw" ? "🛍️" : "✨";
      var sign = tx.type === "withdraw" ? "−" : "+";
      var amtClass = tx.type === "deposit" ? "plus" : tx.type === "withdraw" ? "minus" : "interest";
      var title = tx.type === "interest" ? t("noteInterest") : (tx.note || "");
      var editHint = isParent() ? '<div class="hi-edit">✎</div>' : "";
      li.innerHTML =
        '<div class="hi-icon ' + tx.type + '">' + icon + "</div>" +
        '<div class="hi-main"><div class="hi-title">' + escapeHtml(title) + "</div>" +
        '<div class="hi-sub">' + fmtDate(tx.ts) + "</div></div>" +
        '<div style="text-align:right"><div class="hi-amount ' + amtClass + '">' + sign + nf(tx.amount) + "</div>" +
        '<div class="hi-bal">' + t("balAfter", money(tx._bal)) + "</div></div>" + editHint;
      if (isParent()) {
        li.className = "history-item editable";
        li.onclick = function () { openEditTx(acc, tx); };
      }
      list.appendChild(li);
    });

    if (totalPages > 1) {
      pager.classList.remove("hidden");
      document.getElementById("pager-info").textContent = t("pagerInfo", historyPage + 1, totalPages);
      document.getElementById("pager-prev").disabled = historyPage === 0;
      document.getElementById("pager-next").disabled = historyPage === totalPages - 1;
    } else {
      pager.classList.add("hidden");
    }
  }

  // ================= 對話框 =================
  function openModal(title, bodyHtml, onOk, okText) {
    var modal = document.getElementById("modal");
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = bodyHtml;
    document.getElementById("modal-ok").textContent = okText || t("ok");
    document.getElementById("modal-cancel").textContent = t("cancel");
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open"); // 鎖住背景，避免捲動跑到主頁面
    modal.onclick = function (e) { if (e.target === modal) closeModal(); }; // 點背景關閉
    document.getElementById("modal-cancel").onclick = closeModal;
    document.getElementById("modal-ok").onclick = function () { if (onOk() !== false) closeModal(); };
  }
  function closeModal() { document.getElementById("modal").classList.add("hidden"); document.body.classList.remove("modal-open"); }

  function amountField() {
    var qs = [10, 50, 100, 500].map(function (v) { return '<button type="button" data-amt="' + v + '">+' + v + "</button>"; }).join("");
    var step = state.decimals > 0 ? (1 / Math.pow(10, state.decimals)) : 1;
    return '<div class="modal-body-row"><label>' + t("fieldAmount") + "</label>" +
      '<input id="m-amount" type="number" inputmode="decimal" min="0" max="' + MAX_AMOUNT + '" step="' + step + '" placeholder="' + t("amountPlaceholder") + '" />' +
      '<div class="quick-amounts">' + qs + "</div></div>" +
      '<div class="modal-body-row"><label>' + t("fieldNote") + "</label>" +
      '<input id="m-note" type="text" maxlength="' + NOTE_MAX + '" placeholder="' + t("notePlaceholder") + '" /></div>';
  }
  function wireQuickAmounts() {
    var input = document.getElementById("m-amount");
    document.querySelectorAll(".quick-amounts button").forEach(function (b) {
      b.onclick = function () { input.value = roundTo((parseFloat(input.value) || 0) + parseInt(b.dataset.amt, 10), state.decimals); };
    });
  }
  function readNote() { return document.getElementById("m-note").value.trim().slice(0, NOTE_MAX); }

  function openDeposit() {
    var acc = activeAccount(); if (!acc) return toast(t("pickPersonFirst"));
    openModal(t("depositTo", acc.name), amountField(), function () {
      var amt = validAmount(document.getElementById("m-amount").value);
      if (isNaN(amt)) { toast(t("badAmount")); return false; }
      if (amt === Infinity) { toast(t("amountTooBig")); return false; }
      doDeposit(acc, amt, readNote() || t("noteDeposit"));
    });
    wireQuickAmounts();
  }
  function openWithdraw() {
    var acc = activeAccount(); if (!acc) return toast(t("pickPersonFirst"));
    openModal(t("withdrawFrom", acc.name), amountField(), function () {
      var amt = validAmount(document.getElementById("m-amount").value);
      if (isNaN(amt)) { toast(t("badAmount")); return false; }
      if (amt === Infinity) { toast(t("amountTooBig")); return false; }
      if (amt > balanceOf(acc)) { toast(t("insufficient", money(balanceOf(acc)))); return false; }
      doWithdraw(acc, amt, readNote() || t("noteWithdraw"));
    });
    wireQuickAmounts();
  }
  function openAddAccount() {
    if (state.accounts.length >= MAX_ACCOUNTS) { toast(t("maxAccounts", MAX_ACCOUNTS)); return; }
    var body = '<div class="modal-body-row"><label>' + t("fieldPersonName") + "</label>" +
      '<input id="m-name" type="text" maxlength="' + NAME_MAX + '" placeholder="' + t("namePlaceholder") + '" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldRate") + "</label>" +
      '<input id="m-rate" type="number" inputmode="decimal" min="0" max="' + MAX_RATE_PCT + '" step="0.5" value="5" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldGoalName") + "</label>" +
      '<input id="m-goalname" type="text" maxlength="' + NAME_MAX + '" placeholder="' + t("goalNamePlaceholder") + '" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldGoalAmount") + "</label>" +
      '<input id="m-goalamt" type="number" inputmode="decimal" min="0" step="1" value="0" /></div>' +
      '<div class="modal-note">' + t("rateHint") + "</div>";
    openModal(t("addTitle"), body, function () {
      if (state.accounts.length >= MAX_ACCOUNTS) { toast(t("maxAccounts", MAX_ACCOUNTS)); return; }
      var name = document.getElementById("m-name").value.trim().slice(0, NAME_MAX);
      if (!name) { toast(t("needName")); return false; }
      var rate = clampRatePct(document.getElementById("m-rate").value);
      var gName = document.getElementById("m-goalname").value.trim().slice(0, NAME_MAX);
      var gAmt = clampAmount(document.getElementById("m-goalamt").value);
      addAccount(name, rate / 100, gName, gAmt);
    }, t("create"));
  }

  function toLocalInput(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  // 爸爸模式：點一筆明細 → 修改金額／備註／日期，或刪除這一筆
  function openEditTx(acc, tx) {
    if (!isParent()) return;
    var step = state.decimals > 0 ? (1 / Math.pow(10, state.decimals)) : 1;
    var typeLabel = tx.type === "deposit" ? t("noteDeposit") : tx.type === "withdraw" ? t("noteWithdraw") : t("noteInterest");
    var body =
      '<div class="modal-note">' + t("txType") + "：" + typeLabel + "</div>" +
      '<div class="modal-body-row"><label>' + t("fieldAmount") + "</label>" +
      '<input id="e-amount" type="number" inputmode="decimal" min="0" max="' + MAX_AMOUNT + '" step="' + step + '" value="' + tx.amount + '" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldNote") + "</label>" +
      '<input id="e-note" type="text" maxlength="' + NOTE_MAX + '" value="' + escapeHtml(tx.note || "") + '" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldDate") + "</label>" +
      '<input id="e-date" type="datetime-local" value="' + toLocalInput(tx.ts) + '" /></div>' +
      '<div class="modal-body-row"><button type="button" id="e-delete" class="btn btn-ghost danger-text">' + t("deleteTx") + "</button></div>";
    openModal(t("editTxTitle"), body, function () {
      var amt = validAmount(document.getElementById("e-amount").value);
      if (isNaN(amt)) { toast(t("badAmount")); return false; }
      if (amt === Infinity) { toast(t("amountTooBig")); return false; }
      tx.amount = amt;
      tx.note = document.getElementById("e-note").value.trim().slice(0, NOTE_MAX);
      var ds = document.getElementById("e-date").value;
      var newTs = ds ? new Date(ds).getTime() : tx.ts;
      if (isFinite(newTs)) tx.ts = newTs;
      historyPage = 0; save(); toast(t("txUpdated"));
    }, t("save"));
    document.getElementById("e-delete").onclick = function () {
      if (!confirm(t("confirmDeleteTx"))) return;
      acc.transactions = acc.transactions.filter(function (x) { return x.id !== tx.id; });
      save(); closeModal(); toast(t("txDeleted"));
    };
  }

  function openSettings() {
    var acc = activeAccount();
    var periodOpts = ["minute", "day", "month"].map(function (k) {
      return '<option value="' + k + '"' + (state.interestPeriod === k ? " selected" : "") + ">" + t("period_" + k) + "</option>";
    }).join("");
    var decOpts = [0, 1, 2].map(function (k) {
      return '<option value="' + k + '"' + (state.decimals === k ? " selected" : "") + ">" + t("dec" + k) + "</option>";
    }).join("");
    var accSection = acc ? ('<div class="modal-body-row"><label>' + escapeHtml(t("fieldAccRate", acc.name)) + "</label>" +
      '<input id="s-rate" type="number" inputmode="decimal" min="0" max="' + MAX_RATE_PCT + '" step="0.5" value="' + (+(acc.rateAnnual * 100).toFixed(2)) + '" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldGoalName") + "</label>" +
      '<input id="s-goalname" type="text" maxlength="' + NAME_MAX + '" placeholder="' + t("goalNamePlaceholder") + '" value="' + escapeHtml(acc.goalName || "") + '" /></div>' +
      '<div class="modal-body-row"><label>' + t("fieldGoalAmount") + "</label>" +
      '<input id="s-goalamt" type="number" inputmode="decimal" min="0" step="1" value="' + (acc.goalAmount || 0) + '" /></div>') : "";

    var body =
      '<div class="modal-body-row"><label>' + t("fieldPeriod") + '</label><select id="s-period">' + periodOpts + "</select>" +
      '<div class="modal-note">' + t("periodHint") + "</div></div>" +
      '<div class="modal-body-row"><label>' + t("fieldDecimals") + '</label><select id="s-dec">' + decOpts + "</select></div>" +
      accSection +
      '<div class="modal-body-row"><label>' + t("fieldPin") + "</label>" +
      '<input id="s-pin" type="text" inputmode="numeric" placeholder="' + t("pinPlaceholder") + '" value="' + escapeHtml(state.parentPin || "") + '" />' +
      '<div class="modal-note">' + t("pinHint") + "</div></div>" +
      '<div class="modal-body-row"><label>' + t("dataSection") + "</label>" +
      (acc ? '<button type="button" id="s-csv" class="btn data-btn">' + t("exportCsv") + "</button>" : "") +
      '<button type="button" id="s-backup" class="btn data-btn">' + t("exportBackup") + "</button>" +
      '<button type="button" id="s-restore" class="btn data-btn">' + t("restoreBackup") + "</button>" +
      '<input id="s-file" type="file" accept="application/json,.json" style="display:none" /></div>' +
      (acc ? '<div class="modal-body-row"><button type="button" id="s-delete" class="btn btn-ghost danger-text">' + escapeHtml(t("deletePerson", acc.name)) + "</button></div>" : "");

    openModal(t("settingsTitle"), body, function () {
      state.interestPeriod = document.getElementById("s-period").value;
      state.decimals = parseInt(document.getElementById("s-dec").value, 10);
      state.parentPin = document.getElementById("s-pin").value.trim();
      if (acc) {
        acc.rateAnnual = clampRatePct(document.getElementById("s-rate").value) / 100;
        acc.goalName = document.getElementById("s-goalname").value.trim().slice(0, NAME_MAX);
        acc.goalAmount = clampAmount(document.getElementById("s-goalamt").value);
      }
      save(); toast(t("saved"));
    }, t("save"));

    // 資料：匯出 / 備份 / 還原
    if (acc) document.getElementById("s-csv").onclick = exportCSV;
    document.getElementById("s-backup").onclick = exportBackup;
    document.getElementById("s-restore").onclick = function () { document.getElementById("s-file").click(); };
    document.getElementById("s-file").onchange = function (e) { if (e.target.files && e.target.files[0]) restoreBackup(e.target.files[0]); };

    if (acc) {
      document.getElementById("s-delete").onclick = function () {
        if (!confirm(t("confirmDelete", acc.name))) return;
        state.accounts = state.accounts.filter(function (a) { return a.id !== acc.id; });
        state.activeAccountId = state.accounts.length ? state.accounts[0].id : null;
        save(); closeModal(); toast(t("deleted"));
      };
    }
  }

  function toggleMode() {
    if (isParent()) {                       // 爸爸模式 → 手動回到兒童模式（不需密碼）
      leaveParent(); render(); toast(t("backToChild")); return;
    }
    if (!state.parentPin) {                  // 第一次使用：先設定爸爸密碼
      openModal(t("setParentTitle"),
        '<div class="modal-body-row"><label>' + t("fieldSetParentPw") + '</label>' +
        '<input id="p-pw" type="password" inputmode="numeric" maxlength="' + NAME_MAX + '" /></div>' +
        '<div class="modal-note">' + t("setParentHint") + "</div>",
        function () {
          var pw = document.getElementById("p-pw").value.trim();
          if (!pw) { toast(t("needSetPw")); return false; }
          state.parentPin = pw.slice(0, NAME_MAX);
          enterParent(); save(); toast(t("enteredParent"));
        }, t("ok"));
    } else {                                 // 已有密碼：認證
      openModal(t("enterParentTitle"),
        '<div class="modal-body-row"><label>' + t("fieldEnterPin") + '</label>' +
        '<input id="p-pw" type="password" inputmode="numeric" /></div>',
        function () {
          if (document.getElementById("p-pw").value.trim() === state.parentPin) {
            enterParent(); render(); toast(t("enteredParent"));
          } else { toast(t("wrongPin")); return false; }
        });
    }
  }

  // ================= Toast =================
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("toast");
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 2200);
  }

  // ================= 儲存層 =================
  function save() {
    if (applyingRemote) { render(); return; }
    render();
    store.save(state);
  }
  function afterLoadAccrue() {
    var res = accrueInterest();
    if (res.changed) { store.save(state); if (res.credited > 0) toast(t("creditedToast", nf(res.credited))); }
    render();
  }

  function LocalStore() {}
  LocalStore.prototype.init = function (onReady) {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    state = raw ? safeParse(raw, defaultState()) : defaultState();
    migrate();
    window.addEventListener("storage", function (e) {
      if (e.key === STORAGE_KEY && e.newValue) {
        applyingRemote = true; state = safeParse(e.newValue, state); migrate(); applyingRemote = false; render();
      }
    });
    onReady();
  };
  LocalStore.prototype.save = function (s) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {} };

  function FirebaseStore(config) { this.config = config; }
  FirebaseStore.prototype.init = function (onReady) {
    var self = this;
    loadFirebaseSdk(function () {
      firebase.initializeApp(self.config);
      self.db = firebase.firestore();
      self.auth = firebase.auth();
      isCloud = true;
      document.getElementById("mode-badge").classList.add("cloud");
      self.auth.onAuthStateChanged(function (user) {
        if (!user) { showLogin(self); return; }
        document.getElementById("login").classList.add("hidden");
        document.getElementById("app").classList.remove("hidden");
        self.docRef = self.db.collection("banks").doc(user.uid + "_" + BANK_ID);
        self.docRef.onSnapshot(function (snap) {
          if (snap.exists && snap.data().state) { applyingRemote = true; state = safeParse(snap.data().state, state || defaultState()); migrate(); applyingRemote = false; }
          else if (!state) { state = defaultState(); }
          var res = accrueInterest();
          if (res.changed) { store.save(state); if (res.credited > 0) toast(t("creditedToast", nf(res.credited))); }
          render();
        });
        onReady(true);
      });
    }, function () { toast("Firebase load failed → local mode"); isCloud = false; store = new LocalStore(); store.init(function () { showApp(); afterLoadAccrue(); }); });
  };
  FirebaseStore.prototype.save = function (s) { if (this.docRef) this.docRef.set({ state: JSON.stringify(s), updatedAt: Date.now() }); };

  function showApp() {
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
  }
  function showLogin(fbStore) {
    document.getElementById("app").classList.add("hidden");
    document.getElementById("login").classList.remove("hidden");
    applyStaticI18n();
    var err = document.getElementById("login-error");
    document.getElementById("login-btn").onclick = function () {
      var email = document.getElementById("login-email").value.trim();
      var pw = document.getElementById("login-pw").value;
      err.textContent = "";
      if (!email || pw.length < 6) { err.textContent = t("loginNeed"); return; }
      fbStore.auth.signInWithEmailAndPassword(email, pw).catch(function (e) {
        // 新版 Firebase 開了「Email 列舉保護」時，不存在的帳號會回 invalid-credential 而非 user-not-found，
        // 所以這幾種錯誤都嘗試「自動註冊」；若其實是帳號已存在（密碼打錯），再提示密碼錯誤。
        var maybeNew = e.code === "auth/user-not-found" ||
                       e.code === "auth/invalid-credential" ||
                       e.code === "auth/invalid-login-credentials";
        if (maybeNew) {
          fbStore.auth.createUserWithEmailAndPassword(email, pw).catch(function (e2) {
            if (e2.code === "auth/email-already-in-use") err.textContent = t("loginWrong");
            else err.textContent = t("signupFail", e2.message);
          });
        } else { err.textContent = t("loginFail", e.message); }
      });
    };
  }
  function loadFirebaseSdk(onLoad, onErr) {
    var urls = [
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"
    ];
    var i = 0;
    (function next() {
      if (i >= urls.length) return onLoad();
      var s = document.createElement("script");
      s.src = urls[i++]; s.onload = next; s.onerror = onErr;
      document.head.appendChild(s);
    })();
  }

  // ================= 啟動 =================
  function hasFirebaseConfig() {
    return typeof firebaseConfig === "object" && firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId;
  }
  function boot() {
    document.getElementById("deposit-btn").onclick = openDeposit;
    document.getElementById("withdraw-btn").onclick = openWithdraw;
    document.getElementById("settings-btn").onclick = openSettings;
    document.getElementById("lock-btn").onclick = toggleMode;
    document.getElementById("lang-btn").onclick = function () { setLang(getLang() === "en" ? "zh" : "en"); render(); };
    document.getElementById("pager-prev").onclick = function () { historyPage--; renderHistory(); };
    document.getElementById("pager-next").onclick = function () { historyPage++; renderHistory(); };

    // 任何互動都更新活動時間（給爸爸模式閒置自動上鎖用）
    ["click", "keydown", "touchstart"].forEach(function (ev) {
      document.addEventListener(ev, function () { lastActivity = Date.now(); }, true);
    });

    setInterval(function () {
      if (!state) return;
      if (parentMode && Date.now() - lastActivity > AUTO_LOCK_MS) { leaveParent(); render(); toast(t("autoLocked")); }
      var res = accrueInterest();
      if (res.changed) { store.save(state); if (res.credited > 0) toast(t("creditedToast", nf(res.credited))); }
      render();
    }, 5000);

    if (hasFirebaseConfig()) {
      store = new FirebaseStore(firebaseConfig);
      store.init(function () {});
    } else {
      showApp();
      store = new LocalStore();
      store.init(function () { afterLoadAccrue(); });
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
