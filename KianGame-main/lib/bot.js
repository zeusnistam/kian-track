"use strict";
// Telegram admin bot: live notifications + full control panel (inline keyboards).
const fs = require("fs");
const net = require("net");
const { db, save, flushSync, replaceDb, resetAll, DATA_DIR, DB_FILE, PERSISTENT } = require("./store");
const core = require("./core");
const geo = require("./geo");
const U = require("./util");
const { esc, flag, fmtFull, fmtTime, fmtDur, fmtAgo, num, bar, clip, sleep, log, dayKey } = U;

const TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const ADMINS = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "1601379026")
  .split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
const API = (process.env.TG_API || "https://api.telegram.org").replace(/\/$/, "");
const SITE = process.env.SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "");
const STARTED = Date.now();
const isAdmin = (id) => ADMINS.includes(Number(id));

let running = false;

// ------------------------------------------------------------------ Telegram API
async function tg(method, params = {}, opts = {}) {
  const init = { method: "POST", signal: AbortSignal.timeout(opts.timeout || 20000) };
  if (opts.form) init.body = opts.form;
  else { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(params); }
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, init);
  let j;
  try { j = await res.json(); } catch (e) { throw new Error(`TG ${method}: HTTP ${res.status}`); }
  if (!j.ok) {
    const e = new Error(`TG ${method}: ${j.description}`);
    e.code = j.error_code;
    e.retryAfter = j.parameters && j.parameters.retry_after;
    throw e;
  }
  return j.result;
}

const send = (chat, text, kb, extra = {}) =>
  tg("sendMessage", { chat_id: chat, text: clip(text, 4000), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb, ...extra });

async function edit(chat, mid, text, kb) {
  try {
    await tg("editMessageText", { chat_id: chat, message_id: mid, text: clip(text, 4000), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
  } catch (e) {
    if (/not modified/i.test(e.message)) return;
    await send(chat, text, kb); // message too old / deleted -> send a fresh one
  }
}

// notification queue (Telegram limit: ~1 msg/sec per chat) with overflow protection
const queue = [];
let pumping = false;
let dropped = 0;
function enqueue(job) {
  if (queue.length >= 40) { dropped++; return; }
  queue.push(job);
  pump();
}
async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    for (let a = 0; a < 3; a++) {
      try { await job(); break; }
      catch (e) {
        if (e.retryAfter) await sleep((e.retryAfter + 1) * 1000);
        else { log("notify failed:", e.message); break; }
      }
    }
    await sleep(450);
  }
  if (dropped) {
    const n = dropped; dropped = 0;
    try { for (const id of ADMINS) await send(id, `⚠️ ${n} اعلان به‌دلیل ازدحام نمایش داده نشد.`); } catch (e) {}
  }
  pumping = false;
}
function notify(text, kb) {
  if (!TOKEN) return;
  enqueue(async () => {
    for (const id of ADMINS) {
      try { await send(id, text, kb); }
      catch (e) { if (e.retryAfter) throw e; log("send to admin failed:", e.message); }
    }
  });
}

// ------------------------------------------------------------------ keyboard helpers
const B = (t, d) => ({ text: t, callback_data: d });
const BU = (t, u) => ({ text: t, url: u });
const KB = (rows) => ({ inline_keyboard: rows });
const BACK = [B("🔙 منوی اصلی", "m")];

// ------------------------------------------------------------------ formatting
function devName(dev) {
  dev = dev || {};
  const n = [dev.brand, dev.model].filter(Boolean).join(" ");
  if (n) return n + (dev.approx && dev.brand !== "Apple" ? "" : dev.approx ? " (تقریبی)" : "");
  return { mobile: "موبایل", tablet: "تبلت", desktop: "دسکتاپ/لپ‌تاپ", tv: "تلویزیون" }[dev.type] || "نامشخص";
}
const osName = (dev) => [dev && dev.os, dev && dev.osv].filter(Boolean).join(" ") || "—";
const browserName = (dev) => [dev && dev.browser, dev && dev.bv].filter(Boolean).join(" ") || "—";
function place(v) {
  const p = [v.city, v.region].filter(Boolean);
  return `${flag(v.cc)} ${esc(v.country || "نامشخص")}${p.length ? " — " + esc([...new Set(p)].join("، ")) : ""}`;
}
const stLabel = { menu: "📋 منو", playing: "🎮 در حال بازی", paused: "⏸ مکث", gameover: "💀 باخته", support: "💝 حمایت", milestone: "🏅 جایزه" };

function visitText(v, isNew, head) {
  const lines = [];
  lines.push(head || (isNew ? "🟢 <b>بازدیدکننده جدید</b> 🆕" : `🔵 <b>ورود دوباره</b> 🔁 (بار ${num(v.visits)})`));
  lines.push("");
  lines.push(`🌍 <b>کشور:</b> ${place(v)}`);
  lines.push(`🌐 <b>IP:</b> <code>${esc(v.ip)}</code>${v.proxy ? " ⚠️ VPN/پروکسی/هاست" : ""}`);
  if (v.isp) lines.push(`📡 <b>اینترنت:</b> ${esc(clip(v.isp, 50))}${v.mobileNet ? " (موبایل)" : ""}`);
  lines.push(`📱 <b>دستگاه:</b> ${esc(devName(v.dev))}`);
  lines.push(`⚙️ <b>سیستم‌عامل:</b> ${esc(osName(v.dev))}`);
  lines.push(`🧭 <b>مرورگر:</b> ${esc(browserName(v.dev))}`);
  lines.push(`🖥 <b>صفحه:</b> ${esc(v.scr || "—")} (نمایش ${esc(v.vp || "—")})`);
  const hw = [];
  if (v.mem) hw.push(`RAM ≈ ${v.mem}GB`);
  if (v.cores) hw.push(`${v.cores} هسته`);
  if (v.bat) hw.push(`🔋 ${v.bat.lvl}%${v.bat.chg ? " ⚡" : ""}`);
  if (hw.length) lines.push(`🔧 <b>سخت‌افزار:</b> ${esc(hw.join(" | "))}`);
  if (v.net && (v.net.type || v.net.down)) lines.push(`📶 <b>شبکه:</b> ${esc([v.net.type, v.net.down ? v.net.down + " Mbps" : "", v.net.rtt ? v.net.rtt + "ms" : ""].filter(Boolean).join(" | "))}`);
  lines.push(`🈯 <b>زبان:</b> ${esc(v.lang || "—")} | ⏰ <b>منطقه زمانی:</b> ${esc(v.tz || v.geoTz || "—")}`);
  if (v.ref) lines.push(`🔗 <b>منبع:</b> ${esc(clip(v.ref, 80))}`);
  lines.push(`🕒 <b>ساعت ورود:</b> ${esc(fmtFull(v.lastSeen))}`);
  if (!isNew && v.prevSeen) lines.push(`↩️ <b>بازدید قبلی:</b> ${esc(fmtAgo(v.prevSeen))}`);
  lines.push(`🆔 <code>${esc(v.vid)}</code>`);
  return lines.join("\n");
}

function alertKb(v) {
  const banned = core.isBanned(v.ip, v.cc);
  const rows = [[B(banned ? "✅ رفع بن IP" : "🚫 بن IP", "tb:" + v.ip), B("🔍 جزئیات", "vd:" + v.vid)]];
  const r2 = [];
  if (v.lat != null && v.lon != null) r2.push(BU("📍 نقشه", `https://www.google.com/maps?q=${v.lat},${v.lon}`));
  if (v.cc) r2.push(B(core.isBanned("", v.cc) ? `✅ رفع بن ${v.cc}` : `⛔ بن کشور ${v.cc}`, "tc:" + v.cc));
  if (r2.length) rows.push(r2);
  return KB(rows);
}

// ------------------------------------------------------------------ views
const vlist = () => Object.values(db.visitors);

function mainView() {
  const on = core.getOnline();
  const playing = on.filter((x) => x.s.st === "playing").length;
  const text =
    `🎛 <b>پنل مدیریت کیان‌گیم</b>\n\n` +
    `🟢 آنلاین: <b>${on.length}</b> (🎮 ${playing} در حال بازی)\n` +
    `👥 کل بازدیدکننده‌ها: <b>${num(vlist().length)}</b>\n` +
    `🛠 حالت نگهداری: <b>${db.config.maintenance ? "روشن 🔴" : "خاموش 🟢"}</b>\n` +
    `🚫 بن‌شده‌ها: <b>${db.config.bannedIps.length}</b> IP | <b>${db.config.bannedCountries.length}</b> کشور\n\n` +
    `یکی از بخش‌ها را انتخاب کن 👇`;
  return {
    text,
    kb: KB([
      [B("📊 آمار کلی", "st"), B(`🟢 آنلاین‌ها (${on.length})`, "on")],
      [B("👥 آخرین بازدیدکننده‌ها", "rv:0"), B("🏆 رکوردها", "top")],
      [B("🌍 کشورها", "cn"), B("📱 دستگاه‌ها", "dv")],
      [B("🔎 جستجو", "se"), B("🚫 مدیریت بن", "bn")],
      [B("🛠 کنترل سایت", "ct"), B("📢 بنر / پیام", "msg")],
      [B("🔔 تنظیمات اعلان", "ns"), B("📤 خروجی / بکاپ", "ex")],
      [B("🖥 وضعیت سرور", "sv"), B("🔄 رفرش", "m")],
    ]),
  };
}

function sumDays(n, offset = 0) {
  const r = { visits: 0, uniques: 0, newv: 0, plays: 0, games: 0, scoreSum: 0, best: 0 };
  for (let i = offset; i < offset + n; i++) {
    const d = db.daily[dayKey(Date.now() - i * 86400000)];
    if (!d) continue;
    for (const k of ["visits", "uniques", "newv", "plays", "games", "scoreSum"]) r[k] += d[k] || 0;
    r.best = Math.max(r.best, d.best || 0);
  }
  return r;
}
function statsView() {
  const on = core.getOnline();
  const line = (t, d) => `<b>${t}</b>\n👁 ورود ${num(d.visits)} | 👤 یکتا ${num(d.uniques)} | 🆕 جدید ${num(d.newv)}\n🎮 شروع ${num(d.plays)} | 💀 باخت ${num(d.games)} | میانگین امتیاز ${d.games ? (d.scoreSum / d.games).toFixed(1) : 0} | بهترین ${d.best}`;
  const m = db.meta;
  let chart = "";
  const days = [];
  for (let i = 6; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400000); days.push([k.slice(5), (db.daily[k] || {}).visits || 0]); }
  const max = Math.max(1, ...days.map((d) => d[1]));
  chart = days.map((d) => `<code>${d[0]}</code> ${bar(d[1], max)} ${d[1]}`).join("\n");
  const best = m.bestBy && db.visitors[m.bestBy];
  const text =
    `📊 <b>آمار کلی</b>\n🟢 آنلاین الان: <b>${on.length}</b>\n\n` +
    line("📅 امروز", sumDays(1)) + "\n\n" + line("⏪ دیروز", sumDays(1, 1)) + "\n\n" +
    line("🗓 ۷ روز اخیر", sumDays(7)) + "\n\n" +
    `<b>♾ از ابتدا</b>\n👁 ورود ${num(m.totalVisits)} | 👥 بازدیدکننده ${num(vlist().length)}\n🎮 شروع ${num(m.totalPlays)} | 💀 باخت ${num(m.totalGames)}\n` +
    `🏆 رکورد سایت: <b>${num(m.bestEver)}</b>${best ? " " + flag(best.cc) + " " + esc(devName(best.dev)) : ""}\n\n` +
    `📈 <b>ورودی ۷ روز اخیر</b>\n${chart}`;
  return { text, kb: KB([[B("🔄 بروزرسانی", "st")], BACK]) };
}

function onlineView() {
  const on = core.getOnline();
  let text = `🟢 <b>آنلاین‌ها (${on.length})</b>\n`;
  if (!on.length) text += "\nالان کسی داخل سایت نیست.";
  const rows = [];
  on.slice(0, 15).forEach((x, i) => {
    const v = x.v;
    text += `\n${i + 1}. ${flag(v.cc)} ${esc(clip(v.city || v.country || "؟", 18))} • ${esc(clip(devName(v.dev), 24))}\n   ${stLabel[x.s.st] || "📋"}${x.s.st === "playing" ? ` (امتیاز ${x.s.sc})` : ""} • ⏱ ${esc(fmtDur(Date.now() - x.s.start))}`;
    rows.push([B(`${i + 1}. ${flag(v.cc)} ${clip(devName(v.dev), 26)}`, "v:" + v.vid)]);
  });
  rows.push([B("🔄 بروزرسانی", "on")], BACK);
  return { text, kb: KB(rows) };
}

function recentView(page) {
  const per = 8;
  const all = vlist().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const pages = Math.max(1, Math.ceil(all.length / per));
  page = Math.min(Math.max(0, page), pages - 1);
  const rows = all.slice(page * per, page * per + per).map((v) =>
    [B(clip(`${flag(v.cc)} ${v.city || v.country || "؟"} • ${devName(v.dev)} • ${fmtAgo(v.lastSeen)}`, 60), "v:" + v.vid)]);
  const nav = [];
  if (page > 0) nav.push(B("◀️ قبلی", "rv:" + (page - 1)));
  nav.push(B(`${page + 1}/${pages}`, "noop"));
  if (page < pages - 1) nav.push(B("بعدی ▶️", "rv:" + (page + 1)));
  rows.push(nav, BACK);
  return { text: `👥 <b>آخرین بازدیدکننده‌ها</b> (${num(all.length)} نفر)\nروی هرکدام بزن تا جزئیاتش را ببینی.`, kb: KB(rows) };
}

function visitorView(vid, backTo = "rv:0") {
  const v = db.visitors[vid];
  if (!v) return { text: "❌ این کاربر پیدا نشد (شاید حذف شده).", kb: KB([BACK]) };
  const online = core.getOnline().find((x) => x.v.vid === vid);
  const banned = core.isBanned(v.ip, v.cc);
  let text = visitText(v, false, `👤 <b>پروفایل بازدیدکننده</b> ${online ? "🟢 آنلاین" : "⚫ آفلاین"}${banned ? " 🚫 بن‌شده" : ""}`);
  text += `\n\n🎮 <b>بازی:</b> ${num(v.plays)} شروع | ${num(v.games)} باخت | 🏆 بهترین ${num(v.best)} | میانگین ${v.games ? (v.scoreSum / v.games).toFixed(1) : 0}`;
  text += `\n⏱ <b>مدت حضور کل:</b> ${esc(fmtDur(v.timeMs || 0))} | 👁 ${num(v.visits)} بار ورود`;
  text += `\n📅 <b>اولین ورود:</b> ${esc(fmtFull(v.firstSeen))}`;
  text += `\n🕘 <b>آخرین فعالیت:</b> ${esc(fmtFull(v.lastSeen))}`;
  if (v.ips && v.ips.length > 1) text += `\n🌐 <b>IPهای دیگر:</b> ${v.ips.filter((i) => i !== v.ip).map((i) => "<code>" + esc(i) + "</code>").join(" ")}`;
  const r1 = [B(banned ? "✅ رفع بن IP" : "🚫 بن IP", "tbv:" + vid), B("💬 پیام به کاربر", "dm:" + vid)];
  const r2 = [];
  if (v.lat != null && v.lon != null) r2.push(BU("📍 نقشه", `https://www.google.com/maps?q=${v.lat},${v.lon}`));
  r2.push(B("🔄 بروزرسانی", "v:" + vid));
  return { text, kb: KB([r1, r2, [B("🔙 برگشت", backTo), B("🏠 منو", "m")]]) };
}

function topView() {
  const top = vlist().filter((v) => v.best > 0).sort((a, b) => b.best - a.best).slice(0, 10);
  const medals = ["🥇", "🥈", "🥉"];
  let text = `🏆 <b>بهترین رکوردها</b>\n`;
  if (!top.length) text += "\nهنوز کسی امتیازی ثبت نکرده.";
  const rows = top.map((v, i) => [B(clip(`${medals[i] || i + 1 + "."} ${v.best} — ${flag(v.cc)} ${devName(v.dev)}`, 60), "v:" + v.vid)]);
  rows.push(BACK);
  return { text, kb: KB(rows) };
}

function countriesView() {
  const map = {};
  for (const v of vlist()) {
    const k = v.cc || "??";
    (map[k] = map[k] || { n: 0, visits: 0, name: v.country || "نامشخص", cc: v.cc });
    map[k].n++; map[k].visits += v.visits || 0;
  }
  const arr = Object.values(map).sort((a, b) => b.n - a.n).slice(0, 20);
  const total = vlist().length || 1;
  const max = arr[0] ? arr[0].n : 1;
  let text = `🌍 <b>کشورها</b> (${Object.keys(map).length} کشور)\n\n`;
  text += arr.map((c) => `${flag(c.cc)} ${esc(c.name)}\n<code>${bar(c.n, max)}</code> ${c.n} نفر (${Math.round((c.n / total) * 100)}%) • ${num(c.visits)} ورود`).join("\n");
  return { text: text || "داده‌ای نیست", kb: KB([BACK]) };
}

function devicesView() {
  const count = (fn) => {
    const m = {};
    for (const v of vlist()) { const k = fn(v) || "نامشخص"; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const fmt = (arr, n) => arr.slice(0, n).map(([k, c]) => `• ${esc(clip(k, 36))}: <b>${c}</b>`).join("\n") || "—";
  const types = { mobile: "📱 موبایل", tablet: "📟 تبلت", desktop: "💻 دسکتاپ", tv: "📺 تلویزیون" };
  const text =
    `📱 <b>آمار دستگاه‌ها</b>\n\n<b>نوع</b>\n${fmt(count((v) => types[(v.dev || {}).type]), 5)}\n\n` +
    `<b>سیستم‌عامل</b>\n${fmt(count((v) => (v.dev || {}).os), 6)}\n\n` +
    `<b>مرورگر</b>\n${fmt(count((v) => (v.dev || {}).browser), 6)}\n\n` +
    `<b>مدل‌های پرتکرار</b>\n${fmt(count((v) => [(v.dev || {}).brand, (v.dev || {}).model].filter(Boolean).join(" ")), 10)}`;
  return { text, kb: KB([BACK]) };
}

function searchResults(q) {
  q = q.trim().toLowerCase();
  const res = vlist().filter((v) =>
    (v.ips || []).some((i) => i.includes(q)) || v.vid.toLowerCase().startsWith(q) ||
    [v.country, v.city, v.region, v.isp, v.cc, (v.dev || {}).brand, (v.dev || {}).model, (v.dev || {}).os, (v.dev || {}).browser]
      .some((x) => x && String(x).toLowerCase().includes(q)))
    .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 10);
  const rows = res.map((v) => [B(clip(`${flag(v.cc)} ${v.ip} • ${devName(v.dev)}`, 60), "vd:" + v.vid)]);
  return { text: res.length ? `🔎 <b>${res.length} نتیجه</b> برای «${esc(q)}»` : `🔎 چیزی برای «${esc(q)}» پیدا نشد.`, kb: KB(rows.length ? rows : [[B("🏠 منو", "m")]]) };
}

function bansView() {
  const c = db.config;
  let text = `🚫 <b>مدیریت بن</b>\n\n<b>IPهای بن‌شده:</b> ${c.bannedIps.length ? "" : "—"}\n`;
  text += c.bannedIps.map((i) => "• <code>" + esc(i) + "</code>").join("\n");
  text += `\n\n<b>کشورهای بن‌شده:</b> ${c.bannedCountries.length ? "" : "—"}\n`;
  text += c.bannedCountries.map((x) => `• ${flag(x)} ${x}`).join("\n");
  const rows = [];
  c.bannedIps.slice(0, 12).forEach((i) => rows.push([B("✅ رفع بن " + i, "ubi:" + i)]));
  c.bannedCountries.slice(0, 12).forEach((x) => rows.push([B(`✅ رفع بن ${flag(x)} ${x}`, "ubc:" + x)]));
  rows.push([B("➕ بن IP", "ask:ban_ip"), B("➕ بن کشور", "ask:ban_cc")], BACK);
  return { text, kb: KB(rows) };
}

function controlView() {
  const c = db.config;
  const sp = [0.7, 0.85, 1, 1.2, 1.5];
  const text =
    `🛠 <b>کنترل سایت و بازی</b>\n\n` +
    `🔧 حالت نگهداری: <b>${c.maintenance ? "روشن 🔴" : "خاموش 🟢"}</b>\n` +
    (c.maintenanceText ? `📝 متن: ${esc(clip(c.maintenanceText, 100))}\n` : "") +
    `⚡ سرعت بازی: <b>${c.speedMul}×</b>\n🛡 سپر اول بازی: <b>${c.startShield}</b>\n` +
    `📢 بنر: ${c.banner ? esc(clip(c.banner, 100)) : "—"}\n\n` +
    `تغییرات روی کاربرهای آنلاین ظرف ~۱۵ ثانیه اعمال می‌شود.`;
  return {
    text,
    kb: KB([
      [B(c.maintenance ? "🟢 خاموش کردن نگهداری" : "🔴 روشن کردن نگهداری", "mt"), B("✏️ متن نگهداری", "ask:mtext")],
      sp.map((x) => B((c.speedMul === x ? "✅ " : "") + x + "×", "sp:" + x)),
      [0, 1, 2].map((x) => B((c.startShield === x ? "✅ " : "") + "🛡" + x, "sh:" + x)),
      [B("🔄 رفرش اجباری همه", "rl"), B("📢 بنر / پیام", "msg")],
      BACK,
    ]),
  };
}

function msgView() {
  return {
    text: `📢 <b>بنر و پیام به کاربران</b>\n\nبنر برای همه‌ی بازدیدکننده‌ها (آنلاین و بعدی‌ها) بالای بازی نمایش داده می‌شود.\nبرای پیام به یک نفر خاص از پروفایل او «💬 پیام به کاربر» را بزن.\n\nبنر فعلی: ${db.config.banner ? esc(db.config.banner) : "—"}`,
    kb: KB([[B("✏️ ثبت بنر جدید", "ask:banner"), B("🧹 حذف بنر", "bclr")], [B("🛠 کنترل سایت", "ct")], BACK]),
  };
}

const NS = [
  ["nVisit", "🟢 ورود بازدیدکننده"], ["nEvery", "🔁 هر ورود (حتی رفرش)"], ["nPlay", "🎮 شروع بازی"],
  ["nGameover", "💀 پایان هر بازی"], ["nBest", "🏆 رکورد جدید سایت"], ["nBlocked", "🚫 تلاش کاربر بن‌شده"],
  ["autoBackup", "💾 بکاپ خودکار روزانه"],
];
function settingsView() {
  const rows = NS.map(([k, label]) => [B(`${db.settings[k] ? "✅" : "❌"} ${label}`, "t:" + k)]);
  rows.push(BACK);
  return { text: `🔔 <b>تنظیمات اعلان‌ها</b>\nروی هر مورد بزن تا روشن/خاموش شود.`, kb: KB(rows) };
}

function exportView() {
  return {
    text: `📤 <b>خروجی و بکاپ</b>\n\n• CSV: لیست بازدیدکننده‌ها (برای Excel)\n• JSON: کل دیتابیس (بکاپ کامل)\n\n♻️ برای بازگردانی: فایل JSON بکاپ را برای ربات بفرست و در کپشن بنویس <code>/restore</code>\n\n💾 آخرین بکاپ: ${db.meta.lastBackupAt ? esc(fmtAgo(db.meta.lastBackupAt)) : "—"}`,
    kb: KB([[B("📄 CSV بازدیدکننده‌ها", "exp:csv"), B("💾 بکاپ JSON", "exp:json")], [B("🗑 پاکسازی داده‌ها", "dg")], BACK]),
  };
}

function serverView() {
  let size = 0;
  try { size = fs.statSync(DB_FILE).size; } catch (e) {}
  const mem = process.memoryUsage();
  const text =
    `🖥 <b>وضعیت سرور</b>\n\n⏱ آپتایم: ${esc(fmtDur(process.uptime() * 1000))}\n🧠 رم: ${(mem.rss / 1048576).toFixed(0)} MB\n` +
    `🟢 Node: ${esc(process.version)}\n💾 دیتابیس: ${(size / 1024).toFixed(0)} KB (${num(vlist().length)} کاربر)\n` +
    `📂 مسیر: <code>${esc(DATA_DIR)}</code>\n${PERSISTENT ? "✅ ذخیره‌سازی دائمی" : "⚠️ ذخیره‌سازی موقت! (Volume اضافه کن)"}\n` +
    `🌐 کش IP: ${geo.size()} | صف اعلان: ${queue.length}\n⏰ منطقه زمانی: ${esc(U.TZ)}\n` +
    (SITE ? `🔗 ${esc(SITE)}` : "");
  return { text, kb: KB([[B("🔄 بروزرسانی", "sv")], BACK]) };
}

function dangerView() {
  return {
    text: `🗑 <b>پاکسازی داده‌ها</b>\n\n⚠️ این کارها برگشت‌پذیر نیستند (مگر بکاپ داشته باشی).`,
    kb: KB([[B("🧹 فقط لاگ رویدادها", "dgc:ev")], [B("💣 حذف همه‌ی کاربران و آمار", "dgc:all")], [B("🔙 برگشت", "ex")]]),
  };
}

// ------------------------------------------------------------------ exports
function csvCell(x) {
  const s = String(x == null ? "" : x);
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s; // block spreadsheet formula injection
  return `"${safe.replace(/"/g, '""')}"`;
}
function buildCsv() {
  const head = ["id", "first_seen", "last_seen", "visits", "plays", "games", "best", "avg_score", "time_min", "ip", "country", "cc", "city", "region", "isp", "type", "brand", "model", "os", "browser", "screen", "lang", "timezone", "referrer"];
  const rows = vlist().sort((a, b) => b.lastSeen - a.lastSeen).map((v) => {
    const d = v.dev || {};
    return [v.vid, fmtTime(v.firstSeen), fmtTime(v.lastSeen), v.visits, v.plays, v.games, v.best,
      v.games ? (v.scoreSum / v.games).toFixed(1) : 0, Math.round((v.timeMs || 0) / 60000), v.ip, v.country, v.cc, v.city, v.region,
      v.isp, d.type, d.brand, d.model, [d.os, d.osv].join(" "), [d.browser, d.bv].join(" "), v.scr, v.lang, v.tz, v.ref].map(csvCell).join(",");
  });
  return "\ufeff" + [head.join(","), ...rows].join("\r\n");
}
async function sendDoc(chat, name, buf, mime, caption) {
  const form = new FormData();
  form.append("chat_id", String(chat));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buf], { type: mime }), name);
  return tg("sendDocument", {}, { form, timeout: 60000 });
}
async function sendBackup(chat, auto) {
  flushSync();
  const buf = fs.readFileSync(DB_FILE);
  const stamp = dayKey(Date.now());
  await sendDoc(chat, `kiangame-backup-${stamp}.json`, buf, "application/json",
    `💾 ${auto ? "بکاپ خودکار" : "بکاپ"} — ${fmtTime(Date.now())}\n${num(vlist().length)} کاربر • برای بازگردانی این فایل را بفرست با کپشن /restore`);
  db.meta.lastBackupAt = Date.now();
  save();
}

// ------------------------------------------------------------------ admin input state
const awaiting = new Map(); // adminId -> {type, arg}
const ASK = {
  ban_ip: "🚫 آی‌پی (یا چند آی‌پی با فاصله) را بفرست:",
  ban_cc: "⛔ کد دو حرفی کشور را بفرست (مثلاً <code>US</code> یا <code>DE</code>):",
  mtext: "📝 متنی که در حالت نگهداری به کاربران نشان داده شود را بفرست:",
  banner: "📢 متن بنر را بفرست (بالای بازی برای همه نمایش داده می‌شود):",
  search: "🔎 آی‌پی، کشور، شهر، مدل گوشی، مرورگر، ISP یا شناسه کاربر را بفرست:",
};
const cancelKb = KB([[B("❌ انصراف", "cancel")]]);

async function ask(chat, adminId, type, arg) {
  awaiting.set(adminId, { type, arg });
  await send(chat, (type === "dm" ? "💬 متن پیام برای این کاربر را بفرست:" : ASK[type]) + "\n\n/cancel برای انصراف", cancelKb);
}

async function onAwaited(msg, st) {
  const chat = msg.chat.id;
  const text = (msg.text || "").trim();
  awaiting.delete(msg.from.id);
  if (!text) return send(chat, "❌ متن خالی بود.", KB([BACK]));
  switch (st.type) {
    case "ban_ip": {
      const ips = text.split(/[\s,]+/).filter(Boolean);
      const ok = ips.filter((i) => core.banIp(i));
      const bad = ips.filter((i) => !net.isIP(i));
      return send(chat, `${ok.length ? "🚫 بن شد: " + ok.map((i) => "<code>" + esc(i) + "</code>").join(" ") : ""}${bad.length ? "\n❌ نامعتبر: " + esc(bad.join(" ")) : ""}`, KB([[B("🚫 مدیریت بن", "bn")]]));
    }
    case "ban_cc": {
      const ok = core.banCountry(text);
      return send(chat, ok ? `⛔ کشور ${flag(text)} <b>${esc(text.toUpperCase())}</b> بن شد.` : "❌ کد کشور باید دو حرف باشد (مثل US).", KB([[B("🚫 مدیریت بن", "bn")]]));
    }
    case "mtext":
      db.config.maintenanceText = text.slice(0, 300); save();
      return send(chat, "✅ متن نگهداری ذخیره شد.", KB([[B("🛠 کنترل سایت", "ct")]]));
    case "banner":
      db.config.banner = text.slice(0, 300); db.config.bannerId = (db.config.bannerId || 0) + 1; save();
      return send(chat, "✅ بنر ثبت شد و برای همه نمایش داده می‌شود.", KB([[B("📢 بنر / پیام", "msg")]]));
    case "dm":
      core.queueDM(st.arg, text);
      return send(chat, "✅ پیام در صف ارسال قرار گرفت (وقتی کاربر آنلاین باشد در بازی‌اش نمایش داده می‌شود).", KB([[B("👤 پروفایل", "v:" + st.arg)]]));
    case "search": {
      const r = searchResults(text);
      return send(chat, r.text, r.kb);
    }
  }
}

// ------------------------------------------------------------------ routing
async function route(a, arg, chat, mid, adminId) {
  switch (a) {
    case "m": awaiting.delete(adminId); return mainView();
    case "noop": return { toast: "" };
    case "st": return statsView();
    case "on": return onlineView();
    case "rv": return recentView(parseInt(arg, 10) || 0);
    case "v": return visitorView(arg);
    case "vd": await send(chat, ...Object.values(visitorView(arg, "rv:0"))); return { toast: "" };
    case "top": return topView();
    case "cn": return countriesView();
    case "dv": return devicesView();
    case "se": await ask(chat, adminId, "search"); return { toast: "" };
    case "bn": return bansView();
    case "ask": await ask(chat, adminId, arg); return { toast: "" };
    case "dm": await ask(chat, adminId, "dm", arg); return { toast: "" };
    case "cancel": awaiting.delete(adminId); return { toast: "لغو شد", view: mainView() };
    case "ct": return controlView();
    case "msg": return msgView();
    case "ns": return settingsView();
    case "ex": return exportView();
    case "sv": return serverView();
    case "dg": return dangerView();
    case "t": {
      if (NS.some((x) => x[0] === arg)) { db.settings[arg] = !db.settings[arg]; save(); }
      return settingsView();
    }
    case "mt": db.config.maintenance = !db.config.maintenance; save(); return Object.assign(controlView(), { toast: db.config.maintenance ? "🔴 نگهداری روشن شد" : "🟢 سایت باز شد" });
    case "sp": {
      const x = Number(arg);
      if ([0.7, 0.85, 1, 1.2, 1.5].includes(x)) { db.config.speedMul = x; save(); }
      return Object.assign(controlView(), { toast: `سرعت ${db.config.speedMul}×` });
    }
    case "sh": {
      const x = parseInt(arg, 10);
      if ([0, 1, 2].includes(x)) { db.config.startShield = x; save(); }
      return Object.assign(controlView(), { toast: `سپر ${db.config.startShield}` });
    }
    case "rl": db.config.reloadNonce = (db.config.reloadNonce || 0) + 1; save(); return Object.assign(controlView(), { toast: "🔄 دستور رفرش ارسال شد" });
    case "bclr": db.config.banner = ""; db.config.bannerId = (db.config.bannerId || 0) + 1; save(); return Object.assign(msgView(), { toast: "بنر حذف شد" });
    case "tb": { // toggle ban from alert (message keeps its own text, only keyboard changes)
      if (core.isBanned(arg, "")) core.unbanIp(arg); else core.banIp(arg);
      const v = vlist().find((x) => x.ip === arg);
      return { toast: core.isBanned(arg, "") ? "🚫 IP بن شد" : "✅ بن برداشته شد", markup: v ? alertKb(v) : undefined };
    }
    case "tc": {
      if (core.isBanned("", arg)) core.unbanCountry(arg); else core.banCountry(arg);
      const v = vlist().find((x) => x.cc === arg);
      return { toast: core.isBanned("", arg) ? `⛔ کشور ${arg} بن شد` : "✅ بن کشور برداشته شد", markup: v ? alertKb(v) : undefined };
    }
    case "tbv": {
      const v = db.visitors[arg];
      if (v) { if (core.isBanned(v.ip, "")) core.unbanIp(v.ip); else core.banIp(v.ip); }
      return Object.assign(visitorView(arg), { toast: v && core.isBanned(v.ip, "") ? "🚫 بن شد" : "✅ رفع بن شد" });
    }
    case "ubi": core.unbanIp(arg); return Object.assign(bansView(), { toast: "✅ رفع بن شد" });
    case "ubc": core.unbanCountry(arg); return Object.assign(bansView(), { toast: "✅ رفع بن شد" });
    case "exp":
      if (arg === "csv") await sendDoc(chat, `visitors-${dayKey(Date.now())}.csv`, Buffer.from(buildCsv(), "utf8"), "text/csv", `📄 ${num(vlist().length)} بازدیدکننده`);
      else await sendBackup(chat, false);
      return { toast: "✅ ارسال شد" };
    case "dgc": {
      return {
        text: `⚠️ مطمئنی؟ ${arg === "all" ? "<b>همه‌ی کاربران و آمار پاک می‌شود</b>" : "لاگ رویدادها پاک می‌شود"}.`,
        kb: KB([[B("✅ بله، انجام بده", "dgy:" + arg), B("❌ نه", "dg")]]),
      };
    }
    case "dgy":
      if (arg === "all") resetAll(); else { db.events.length = 0; save(); }
      return Object.assign(exportView(), { toast: "🧹 انجام شد" });
    default: return { toast: "؟" };
  }
}

async function onCallback(cq) {
  const adminId = cq.from.id;
  if (!isAdmin(adminId)) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ دسترسی نداری", show_alert: true });
  const msg = cq.message;
  if (!msg) return tg("answerCallbackQuery", { callback_query_id: cq.id });
  const chat = msg.chat.id, mid = msg.message_id;
  const data = String(cq.data || "");
  const i = data.indexOf(":");
  const a = i < 0 ? data : data.slice(0, i);
  const arg = i < 0 ? "" : data.slice(i + 1);
  let r;
  try { r = await route(a, arg, chat, mid, adminId); }
  catch (e) { log("callback error:", a, e.message); r = { toast: "❌ خطا: " + clip(e.message, 100) }; }
  try { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: r.toast || undefined }); } catch (e) {}
  try {
    if (r.markup) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: r.markup });
    else if (r.view) await edit(chat, mid, r.view.text, r.view.kb);
    else if (r.text) await edit(chat, mid, r.text, r.kb);
  } catch (e) { if (!/not modified/i.test(e.message)) log("edit error:", e.message); }
}

// ------------------------------------------------------------------ text commands
const HELP =
  `📖 <b>راهنما</b>\n\n/panel — پنل اصلی\n/stats — آمار\n/online — آنلاین‌ها\n/find متن — جستجو (IP، کشور، مدل…)\n` +
  `/ban آی‌پی یا کد‌کشور — بن\n/unban آی‌پی یا کد‌کشور — رفع بن\n/say متن — بنر برای همه\n/maintenance on|off — نگهداری\n` +
  `/backup — بکاپ دیتابیس\n/restore — (روی فایل JSON بکاپ کپشن کن)\n/cancel — لغو`;

async function onCommand(msg, cmd, rest) {
  const chat = msg.chat.id;
  const showView = (v) => send(chat, v.text, v.kb);
  switch (cmd) {
    case "start": case "panel": case "menu": return showView(mainView());
    case "help": return send(chat, HELP, KB([BACK]));
    case "stats": return showView(statsView());
    case "online": return showView(onlineView());
    case "cancel": awaiting.delete(msg.from.id); return send(chat, "❌ لغو شد.", KB([BACK]));
    case "find": { if (!rest) return ask(chat, msg.from.id, "search"); const r = searchResults(rest); return send(chat, r.text, r.kb); }
    case "ban": case "unban": {
      if (!rest) return send(chat, `استفاده: /${cmd} 1.2.3.4  یا  /${cmd} US`);
      const x = rest.split(/\s+/)[0];
      let ok;
      if (net.isIP(x)) ok = cmd === "ban" ? core.banIp(x) : core.unbanIp(x);
      else if (/^[A-Za-z]{2}$/.test(x)) ok = cmd === "ban" ? core.banCountry(x) : core.unbanCountry(x);
      else return send(chat, "❌ ورودی معتبر نیست.");
      return send(chat, ok ? `${cmd === "ban" ? "🚫 بن شد" : "✅ رفع بن شد"}: <code>${esc(x)}</code>` : "ℹ️ تغییری انجام نشد.", KB([[B("🚫 مدیریت بن", "bn")]]));
    }
    case "say":
      if (!rest) return ask(chat, msg.from.id, "banner");
      db.config.banner = rest.slice(0, 300); db.config.bannerId = (db.config.bannerId || 0) + 1; save();
      return send(chat, "✅ بنر ثبت شد.", KB([[B("📢 بنر / پیام", "msg")]]));
    case "maintenance": {
      const on = /^(on|1|روشن)$/i.test(rest), off = /^(off|0|خاموش)$/i.test(rest);
      if (!on && !off) return showView(controlView());
      db.config.maintenance = on; save();
      return send(chat, on ? "🔴 حالت نگهداری روشن شد." : "🟢 سایت دوباره باز شد.", KB([[B("🛠 کنترل سایت", "ct")]]));
    }
    case "backup": await sendBackup(chat, false); return;
    case "restore": return send(chat, "♻️ فایل JSON بکاپ را بفرست و در کپشنش بنویس <code>/restore</code>");
    default: return send(chat, "دستور نامعتبر. /help");
  }
}

async function onDocument(msg) {
  const chat = msg.chat.id;
  const cap = (msg.caption || "").trim();
  if (!/^\/restore/i.test(cap)) return send(chat, "برای بازگردانی بکاپ، کپشن فایل را <code>/restore</code> بگذار.");
  const doc = msg.document;
  if (doc.file_size > 19 * 1024 * 1024) return send(chat, "❌ فایل بزرگ‌تر از ۲۰ مگابایت است.");
  const f = await tg("getFile", { file_id: doc.file_id });
  const res = await fetch(`${API}/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("download failed " + res.status);
  let obj;
  try { obj = JSON.parse(await res.text()); } catch (e) { return send(chat, "❌ فایل JSON معتبر نیست."); }
  if (!obj || typeof obj.visitors !== "object") return send(chat, "❌ این فایل بکاپ کیان‌گیم نیست.");
  replaceDb(obj);
  return send(chat, `✅ بازگردانی شد: ${num(Object.keys(db.visitors).length)} کاربر`, KB([BACK]));
}

const strangers = new Map();
async function onMessage(msg) {
  if (!msg.from || msg.chat.type !== "private") return;
  if (!isAdmin(msg.from.id)) {
    const last = strangers.get(msg.from.id) || 0;
    if (Date.now() - last > 3600000) {
      strangers.set(msg.from.id, Date.now());
      await send(msg.chat.id, "⛔ این ربات خصوصی است.");
      notify(`👀 کاربر ناشناس به ربات پیام داد:\n${esc([msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "))} ${msg.from.username ? "@" + esc(msg.from.username) : ""}\n<code>${msg.from.id}</code>`);
    }
    return;
  }
  if (msg.document) return onDocument(msg);
  const text = (msg.text || "").trim();
  const m = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (m) { awaiting.delete(msg.from.id); return onCommand(msg, m[1].toLowerCase(), (m[2] || "").trim()); }
  const st = awaiting.get(msg.from.id);
  if (st) return onAwaited(msg, st);
  return send(msg.chat.id, "از منو استفاده کن 👇", mainView().kb);
}

async function handleUpdate(u) {
  try {
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) await onMessage(u.message);
  } catch (e) {
    log("update error:", e.message);
    try {
      const chat = (u.message && u.message.chat.id) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat.id);
      if (chat && ADMINS.includes(chat)) await send(chat, "❌ خطا: " + esc(clip(e.message, 200)));
    } catch (e2) {}
  }
}

// ------------------------------------------------------------------ live notifications
function wire() {
  const S = () => db.settings;
  core.bus.on("visit", ({ v, isNew, notify: n }) => {
    if (S().nVisit && n) notify(visitText(v, isNew), S().buttons === false ? undefined : alertKb(v));
  });
  core.bus.on("play", ({ v }) => {
    if (S().nPlay) notify(`🎮 <b>شروع بازی</b> — ${flag(v.cc)} ${esc(devName(v.dev))} (<code>${esc(v.ip)}</code>)`);
  });
  core.bus.on("gameover", ({ v, score, personalBest, record }) => {
    if (record && S().nBest) notify(`🏆 <b>رکورد جدید سایت: ${score}</b>\n${place(v)}\n📱 ${esc(devName(v.dev))}\n🌐 <code>${esc(v.ip)}</code>`, KB([[B("🔍 پروفایل", "vd:" + v.vid)]]));
    else if (S().nGameover) notify(`💀 <b>پایان بازی</b> — امتیاز <b>${score}</b>${personalBest ? " 🌟 رکورد شخصی" : ""}\n${flag(v.cc)} ${esc(devName(v.dev))} (<code>${esc(v.ip)}</code>)`);
  });
  core.bus.on("blocked", ({ ip, cc, geo: g, dev }) => {
    if (S().nBlocked) notify(`🚫 <b>تلاش ورود کاربر بن‌شده</b>\n🌐 <code>${esc(ip)}</code> ${flag(cc)} ${esc(g.country || cc || "")}\n📱 ${esc(devName(dev))}`);
  });
  core.bus.on("dm", ({ vid }) => {
    const v = db.visitors[vid];
    if (v) notify(`✅ پیام شما به ${flag(v.cc)} ${esc(devName(v.dev))} تحویل داده شد.`);
  });
}

// ------------------------------------------------------------------ polling
async function pollLoop() {
  let offset = 0, backoff = 1000;
  while (running) {
    try {
      const ups = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, { timeout: 40000 });
      backoff = 1000;
      for (const u of ups) {
        offset = u.update_id + 1;
        handleUpdate(u); // not awaited on purpose: one slow handler can't block the rest
      }
    } catch (e) {
      if (!running) break;
      if (e.code === 401) { log("❌ BOT_TOKEN is invalid — bot stopped (site keeps running)."); return; }
      if (e.code === 409) { log("409 conflict (another instance polling?) — retrying"); await sleep(4000); continue; }
      log("poll error:", e.message);
      await sleep(e.retryAfter ? e.retryAfter * 1000 : backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function start() {
  if (!TOKEN) {
    log("⚠️ BOT_TOKEN is not set — Telegram bot disabled (the website works normally).");
    return;
  }
  wire();
  try {
    const me = await tg("getMe");
    log(`Telegram bot @${me.username} connected. Admins: ${ADMINS.join(", ")}`);
  } catch (e) {
    log("❌ Telegram getMe failed:", e.message, "— check BOT_TOKEN");
    if (e.code === 401) return;
  }
  try { await tg("deleteWebhook", { drop_pending_updates: false }); } catch (e) {}
  try {
    await tg("setMyCommands", {
      commands: [
        { command: "panel", description: "پنل مدیریت" }, { command: "stats", description: "آمار" },
        { command: "online", description: "کاربران آنلاین" }, { command: "find", description: "جستجو" },
        { command: "ban", description: "بن IP یا کشور" }, { command: "unban", description: "رفع بن" },
        { command: "say", description: "بنر برای همه" }, { command: "maintenance", description: "حالت نگهداری" },
        { command: "backup", description: "بکاپ دیتابیس" }, { command: "help", description: "راهنما" },
      ],
    });
  } catch (e) {}
  running = true;
  pollLoop();

  // daily backup straight to Telegram (so you never lose data even without a volume)
  setInterval(async () => {
    try {
      if (db.settings.autoBackup && Date.now() - (db.meta.lastBackupAt || 0) > 24 * 3600 * 1000 && vlist().length) {
        for (const id of ADMINS) await sendBackup(id, true);
      }
    } catch (e) { log("auto backup failed:", e.message); }
  }, 30 * 60 * 1000).unref();

  notify(
    `✅ <b>سرور روشن شد</b>\n${SITE ? "🔗 " + esc(SITE) + "\n" : ""}📦 ${num(vlist().length)} کاربر در دیتابیس\n` +
    (PERSISTENT ? "" : "⚠️ ذخیره‌سازی دائمی نیست! در Railway یک Volume به مسیر /data وصل کن و DATA_DIR=/data بگذار. (بکاپ خودکار روزانه فعال است.)\n") +
    `\n/panel برای باز کردن پنل`,
    KB([[B("🎛 پنل", "m")]]),
  );
}

function stop() { running = false; }

module.exports = { start, stop, notify };
