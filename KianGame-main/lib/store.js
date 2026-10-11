"use strict";
// Tiny JSON "database" with atomic writes + debounce. No dependencies.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { dayKey, log } = require("./util");

function pickDir() {
  const cands = [
    process.env.DATA_DIR,
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    path.join(__dirname, "..", "data"),
    path.join(os.tmpdir(), "kiangame-data"),
  ].filter(Boolean);
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch (e) { /* try next */ }
  }
  throw new Error("No writable data directory");
}

const DATA_DIR = pickDir();
const DB_FILE = path.join(DATA_DIR, "db.json");
const MAX_VISITORS = 12000;
const MAX_EVENTS = 300;
const PERSISTENT = !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) || !process.env.RAILWAY_ENVIRONMENT;

function defaults() {
  return {
    v: 1,
    visitors: {},
    events: [],
    daily: {},
    config: {
      maintenance: false, maintenanceText: "", banner: "", bannerId: 0,
      speedMul: 1, startShield: 0, reloadNonce: 0, bannedIps: [], bannedCountries: [],
    },
    settings: {
      nVisit: true, nEvery: false, nPlay: false, nGameover: false, nBest: true,
      nBlocked: true, autoBackup: true, buttons: true,
    },
    meta: {
      createdAt: Date.now(), lastBackupAt: 0, totalVisits: 0, totalPlays: 0,
      totalGames: 0, bestEver: 0, bestBy: "",
    },
  };
}

function normalize(raw) {
  const d = defaults();
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {
    v: 1,
    visitors: r.visitors && typeof r.visitors === "object" ? r.visitors : {},
    events: Array.isArray(r.events) ? r.events : [],
    daily: r.daily && typeof r.daily === "object" ? r.daily : {},
    config: Object.assign(d.config, r.config || {}),
    settings: Object.assign(d.settings, r.settings || {}),
    meta: Object.assign(d.meta, r.meta || {}),
  };
  if (!Array.isArray(out.config.bannedIps)) out.config.bannedIps = [];
  if (!Array.isArray(out.config.bannedCountries)) out.config.bannedCountries = [];
  return out;
}

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return normalize(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
    }
  } catch (e) {
    log("DB read failed, starting fresh:", e.message);
    try { fs.renameSync(DB_FILE, DB_FILE.replace(/\.json$/, `.corrupt.${Date.now()}.json`)); } catch (e2) {}
  }
  return defaults();
}

const db = load();

function prune() {
  const ids = Object.keys(db.visitors);
  if (ids.length > MAX_VISITORS) {
    ids.sort((a, b) => (db.visitors[a].lastSeen || 0) - (db.visitors[b].lastSeen || 0));
    const kill = ids.length - Math.floor(MAX_VISITORS * 0.9);
    for (let i = 0; i < kill; i++) delete db.visitors[ids[i]];
  }
  if (db.events.length > MAX_EVENTS + 50) db.events.splice(0, db.events.length - MAX_EVENTS);
  const days = Object.keys(db.daily).sort();
  while (days.length > 150) delete db.daily[days.shift()];
}

let timer = null;
let dirty = false;
function writeNow() {
  try {
    prune();
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
    return true;
  } catch (e) {
    log("DB write failed:", e.message);
    return false;
  }
}
function save() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; writeNow(); }, 3000);
  if (timer.unref) timer.unref();
}
function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (dirty || !fs.existsSync(DB_FILE)) writeNow();
}
function replaceDb(obj) {
  const n = normalize(obj);
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, n);
  dirty = true;
  flushSync();
}
function resetAll() {
  const d = defaults();
  // keep config + settings, wipe collected data
  d.config = db.config; d.settings = db.settings;
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, d);
  dirty = true;
  flushSync();
}
function today() {
  const k = dayKey(Date.now());
  if (!db.daily[k]) db.daily[k] = { visits: 0, uniques: 0, newv: 0, plays: 0, games: 0, scoreSum: 0, best: 0 };
  return db.daily[k];
}
function pushEvent(e) {
  db.events.push(Object.assign({ t: Date.now() }, e));
  if (db.events.length > MAX_EVENTS + 50) db.events.splice(0, db.events.length - MAX_EVENTS);
}

module.exports = { db, save, flushSync, replaceDb, resetAll, today, pushEvent, DATA_DIR, DB_FILE, PERSISTENT };
