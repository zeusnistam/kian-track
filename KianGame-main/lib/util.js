"use strict";
// Small helpers shared by the server and the bot.

const TZ = process.env.TIMEZONE || "Asia/Tehran";

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function flag(cc) {
  if (typeof cc === "string" && /^[A-Za-z]{2}$/.test(cc)) {
    return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
  }
  return "🏳️";
}

let dtf = null, dayf = null, jalf = null;
try {
  dtf = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  dayf = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
} catch (e) { dtf = dayf = null; }
try {
  jalf = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
} catch (e) { jalf = null; }

function fmtTime(ts) {
  try { if (dtf) return dtf.format(ts); } catch (e) {}
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}
function fmtFull(ts) {
  let j = "";
  try { if (jalf) j = " — " + jalf.format(ts); } catch (e) {}
  return fmtTime(ts) + j;
}
function dayKey(ts) {
  try { if (dayf) return dayf.format(ts); } catch (e) {}
  return new Date(ts).toISOString().slice(0, 10);
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} ثانیه`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} دقیقه`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ساعت${m % 60 ? " و " + (m % 60) + " دقیقه" : ""}`;
  return `${Math.floor(h / 24)} روز`;
}
function fmtAgo(ts) {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 15000) return "همین الان";
  return fmtDur(d) + " پیش";
}
const num = (n) => Number(n || 0).toLocaleString("en-US");
const bar = (n, max, w = 10) => "█".repeat(max > 0 ? Math.round((n / max) * w) : 0) || "▏";
const clip = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

module.exports = { TZ, esc, flag, fmtTime, fmtFull, dayKey, fmtDur, fmtAgo, num, bar, clip, sleep, log };
