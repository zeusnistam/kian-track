"use strict";
// Core logic: tracking events from the site, sessions (online users), bans,
// remote config, direct messages. The Telegram bot listens to `bus`.
const net = require("net");
const { EventEmitter } = require("events");
const { db, save, today, pushEvent } = require("./store");
const geo = require("./geo");
const { parseUA } = require("./ua");
const { dayKey } = require("./util");

const bus = new EventEmitter();
const ONLINE_MS = 75000;
const SESSION_GAP = 30 * 60 * 1000;
const sessions = new Map(); // sid -> {vid, start, last, ip, st, sc}
const dmQueue = new Map(); // vid -> [{id, text}]
const blockedSeen = new Map(); // ip -> ts
let dmCounter = 1;

const cleanId = (v) => (typeof v === "string" && /^[A-Za-z0-9]{8,40}$/.test(v) ? v : "");
const str = (v, n = 80) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
const numIn = (v, min, max) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
};
const emit = (ev, data) => { try { bus.emit(ev, data); } catch (e) { console.error("bus error", e); } };

function cfgPublic() {
  const c = db.config;
  return {
    maintenance: !!c.maintenance, maintenanceText: c.maintenanceText || "",
    banner: c.banner || "", bannerId: c.bannerId || 0,
    speedMul: c.speedMul || 1, startShield: c.startShield || 0, reload: c.reloadNonce || 0,
  };
}

function isBanned(ip, cc) {
  return db.config.bannedIps.includes(ip) || (!!cc && db.config.bannedCountries.includes(String(cc).toUpperCase()));
}
function banIp(ip) {
  if (!net.isIP(ip)) return false;
  if (!db.config.bannedIps.includes(ip)) db.config.bannedIps.push(ip);
  save();
  return true;
}
function unbanIp(ip) {
  const i = db.config.bannedIps.indexOf(ip);
  if (i >= 0) db.config.bannedIps.splice(i, 1);
  save();
  return i >= 0;
}
function banCountry(cc) {
  cc = String(cc).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return false;
  if (!db.config.bannedCountries.includes(cc)) db.config.bannedCountries.push(cc);
  save();
  return true;
}
function unbanCountry(cc) {
  const i = db.config.bannedCountries.indexOf(String(cc).toUpperCase());
  if (i >= 0) db.config.bannedCountries.splice(i, 1);
  save();
  return i >= 0;
}

function queueDM(vid, text) {
  const q = dmQueue.get(vid) || [];
  if (q.length >= 5) q.shift();
  q.push({ id: dmCounter++, text: String(text).slice(0, 500) });
  dmQueue.set(vid, q);
}

function getOnline() {
  const now = Date.now();
  const out = [];
  for (const [sid, s] of sessions) {
    if (now - s.last <= ONLINE_MS) out.push({ sid, s, v: db.visitors[s.vid] });
  }
  return out.filter((x) => x.v).sort((a, b) => b.s.last - a.s.last);
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.last > ONLINE_MS * 4) sessions.delete(sid);
  for (const [ip, t] of blockedSeen) if (now - t > 600000) blockedSeen.delete(ip);
}, 30000).unref();

function respond(base, vid) {
  const q = dmQueue.get(vid);
  if (q && q.length) {
    base.msg = q.shift();
    emit("dm", { vid, text: base.msg.text });
  }
  return base;
}

// body = parsed JSON from /api/track, hdrCc = country code from a CDN header (optional)
async function handleTrack(ip, ua, body, hdrCc) {
  const base = { ok: true, cfg: cfgPublic() };
  if (!body || typeof body !== "object") return { ok: false };
  const t = str(body.t, 12);
  const sid = cleanId(body.sid);
  const vid = cleanId(body.vid);
  if (!sid || !vid) return { ok: false };
  const now = Date.now();
  let v = db.visitors[vid];

  // ---------------- first load of a page ----------------
  if (t === "visit") {
    const d = body.d && typeof body.d === "object" ? body.d : {};
    const chRaw = d.ch && typeof d.ch === "object" ? d.ch : {};
    const ch = {
      model: str(chRaw.model, 60), pv: str(chRaw.pv, 20), platform: str(chRaw.platform, 30),
      mobile: chRaw.mobile === true, arch: str(chRaw.arch, 12),
    };
    const scr = {
      sw: numIn(d.sw, 0, 20000) || 0, sh: numIn(d.sh, 0, 20000) || 0,
      dpr: numIn(d.dpr, 0, 10) || 0, touch: numIn(d.touch, 0, 50) || 0,
    };
    const dev = parseUA(ua, ch, scr);
    if (dev.bot) return base;

    const existing = sessions.get(sid);
    if (existing) { existing.last = now; return respond(base, vid); } // duplicate visit call

    const g = (await geo.lookup(ip)) || {};
    const cc = String(g.cc || hdrCc || "").toUpperCase();
    if (isBanned(ip, cc)) {
      if (!blockedSeen.has(ip)) {
        blockedSeen.set(ip, now);
        emit("blocked", { ip, cc, geo: g, dev, vid });
      }
      return { ok: true, cfg: base.cfg, blocked: true };
    }

    const isNew = !v;
    if (!v) {
      v = db.visitors[vid] = {
        vid, firstSeen: now, lastSeen: now, visits: 0, plays: 0, games: 0, best: 0,
        scoreSum: 0, timeMs: 0, ips: [],
      };
    }
    const gap = now - (v.lastSeen || 0);
    v.prevSeen = isNew ? 0 : v.lastSeen;
    v.visits++;
    v.lastSeen = now;
    v.ip = ip;
    if (!v.ips.includes(ip)) { v.ips.push(ip); if (v.ips.length > 10) v.ips.shift(); }
    v.cc = cc; v.country = g.country || ""; v.city = g.city || ""; v.region = g.region || "";
    v.isp = g.isp || ""; v.lat = g.lat != null ? g.lat : null; v.lon = g.lon != null ? g.lon : null;
    v.proxy = !!g.proxy; v.mobileNet = !!g.mobile; v.geoTz = g.tz || "";
    v.dev = { type: dev.type, brand: dev.brand, model: dev.model, os: dev.os, osv: dev.osv, browser: dev.browser, bv: dev.bv, approx: dev.approx };
    v.ua = str(ua, 220);
    v.scr = `${scr.sw}x${scr.sh}@${scr.dpr || 1}`;
    v.vp = `${numIn(d.vw, 0, 20000) || 0}x${numIn(d.vh, 0, 20000) || 0}`;
    v.lang = str(d.lang, 20); v.tz = str(d.tz, 40);
    v.mem = numIn(d.mem, 0, 1024); v.cores = numIn(d.cores, 0, 512);
    v.touchPts = scr.touch;
    const c = d.conn && typeof d.conn === "object" ? d.conn : {};
    v.net = { type: str(c.type, 12), down: numIn(c.down, 0, 100000), rtt: numIn(c.rtt, 0, 100000), save: c.save === true };
    const b = d.bat && typeof d.bat === "object" ? d.bat : null;
    v.bat = b ? { lvl: numIn(b.lvl, 0, 100), chg: b.chg === true } : null;
    v.ref = str(d.ref, 120);
    v.pwa = d.pwa === true;

    const day = today();
    day.visits++;
    meta().totalVisits++;
    const dk = dayKey(now);
    if (v.lastDay !== dk) { day.uniques++; v.lastDay = dk; }
    if (isNew) day.newv++;
    sessions.set(sid, { vid, start: now, last: now, ip, st: "menu", sc: 0 });
    pushEvent({ type: "visit", vid, ip, cc });
    save();

    const notify = isNew || gap > SESSION_GAP || db.settings.nEvery;
    emit("visit", { v, isNew, notify, ip, gap });
    return respond(base, vid);
  }

  // ---------------- every other event needs a known visitor ----------------
  if (!v) return { ok: true, cfg: base.cfg, need: "visit" };
  if (isBanned(ip, v.cc)) return { ok: true, cfg: base.cfg, blocked: true };

  let s = sessions.get(sid);
  if (!s) {
    s = { vid, start: now, last: now, ip, st: "menu", sc: 0 };
    sessions.set(sid, s);
  }

  if (t === "end") {
    sessions.delete(sid);
    v.lastSeen = now;
    save();
    return base;
  }

  const dt = Math.min(now - s.last, 30000);
  if (dt > 0 && (t === "hb")) v.timeMs += dt;
  s.last = now;
  v.lastSeen = now;
  if (ip && ip !== v.ip) { v.ip = ip; s.ip = ip; if (!v.ips.includes(ip)) { v.ips.push(ip); if (v.ips.length > 10) v.ips.shift(); } }

  if (t === "hb") {
    s.st = str(body.st, 12) || s.st;
    s.sc = numIn(body.sc, 0, 1e6) || 0;
    return respond(base, vid);
  }

  if (t === "play") {
    v.plays++;
    today().plays++;
    meta().totalPlays++;
    s.st = "playing"; s.sc = 0;
    save();
    emit("play", { v, ip });
    return respond(base, vid);
  }

  if (t === "gameover") {
    const score = Math.floor(numIn(body.score, 0, 1e6) || 0);
    const prevBest = v.best || 0;
    v.games++;
    v.scoreSum += score;
    if (score > v.best) v.best = score;
    const day = today();
    day.games++;
    day.scoreSum += score;
    if (score > day.best) day.best = score;
    const m = meta();
    m.totalGames++;
    let record = false;
    if (score > m.bestEver) { m.bestEver = score; m.bestBy = vid; record = score >= 5; }
    s.st = "gameover"; s.sc = score;
    save();
    emit("gameover", { v, ip, score, personalBest: score > prevBest, record });
    return respond(base, vid);
  }

  return respond(base, vid);
}

function meta() { return db.meta; }

module.exports = {
  bus, handleTrack, getOnline, sessions, isBanned, banIp, unbanIp, banCountry, unbanCountry,
  queueDM, cfgPublic, ONLINE_MS,
};
