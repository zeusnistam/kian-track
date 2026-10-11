/* Visitor tracking + remote control client (talks to /api/track).
   Exposes window.KG used by game.js. Never throws into the game. */
(() => {
  "use strict";
  const KG = (window.KG = { cfg: {}, locked: false, event, getState: null });

  const rid = (n) => {
    const a = new Uint8Array(n);
    try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < n; i++) a[i] = Math.random() * 256; }
    return Array.from(a, (b) => (b % 36).toString(36)).join("");
  };

  let vid = "";
  try { vid = localStorage.getItem("kg_vid") || ""; } catch (e) {}
  if (!/^[A-Za-z0-9]{8,40}$/.test(vid)) {
    vid = rid(14);
    try { localStorage.setItem("kg_vid", vid); } catch (e) {}
  }
  const sid = rid(12);

  let reloadNonce = null;
  let visited = false;
  let seenBanner = 0;
  try { seenBanner = parseInt(localStorage.getItem("kg_banner") || "0", 10) || 0; } catch (e) {}

  function post(body, beacon) {
    body.sid = sid;
    body.vid = vid;
    const json = JSON.stringify(body);
    if (beacon && navigator.sendBeacon) {
      try { navigator.sendBeacon("/api/track", new Blob([json], { type: "text/plain;charset=UTF-8" })); } catch (e) {}
      return Promise.resolve(null);
    }
    return fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: json,
      keepalive: true,
      cache: "no-store",
    }).then((r) => r.json()).catch(() => null);
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  }

  async function collect() {
    const d = {
      sw: screen.width, sh: screen.height, dpr: window.devicePixelRatio || 1,
      vw: window.innerWidth, vh: window.innerHeight,
      lang: navigator.language || "", tz: "",
      mem: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 0,
      touch: navigator.maxTouchPoints || 0, ref: document.referrer || "",
      pwa: !!(window.matchMedia && matchMedia("(display-mode: standalone)").matches),
    };
    try { d.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    try {
      const c = navigator.connection || navigator.mozConnection;
      if (c) d.conn = { type: c.effectiveType || c.type || "", down: c.downlink || 0, rtt: c.rtt || 0, save: !!c.saveData };
    } catch (e) {}
    try {
      const u = navigator.userAgentData;
      if (u && u.getHighEntropyValues) {
        const h = await withTimeout(u.getHighEntropyValues(["model", "platformVersion", "architecture"]), 900);
        d.ch = { model: (h && h.model) || "", pv: (h && h.platformVersion) || "", arch: (h && h.architecture) || "", platform: u.platform || "", mobile: !!u.mobile };
      }
    } catch (e) {}
    try {
      if (navigator.getBattery) {
        const b = await withTimeout(navigator.getBattery(), 600);
        if (b) d.bat = { lvl: Math.round(b.level * 100), chg: !!b.charging };
      }
    } catch (e) {}
    return d;
  }

  // ---------------- UI (lock overlay / banner / direct message) ----------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function showLock(icon, title, text) {
    let o = document.getElementById("kg-lock");
    if (!o) {
      o = el("div"); o.id = "kg-lock";
      const c = el("div", "kg-lock-card");
      c.appendChild(el("div", "kg-lock-icon"));
      c.appendChild(el("div", "kg-lock-title"));
      c.appendChild(el("div", "kg-lock-text"));
      o.appendChild(c);
      document.body.appendChild(o);
    }
    o.querySelector(".kg-lock-icon").textContent = icon;
    o.querySelector(".kg-lock-title").textContent = title;
    o.querySelector(".kg-lock-text").textContent = text || "";
    o.style.display = "flex";
  }
  function hideLock() {
    const o = document.getElementById("kg-lock");
    if (o) o.style.display = "none";
  }
  function showNote(text, kind, onClose) {
    const n = el("div", "kg-note " + (kind || ""));
    n.appendChild(el("span", "kg-note-text", text));
    const x = el("button", "kg-note-x", "✕");
    x.type = "button";
    x.addEventListener("click", () => { n.remove(); if (onClose) onClose(); });
    n.appendChild(x);
    document.body.appendChild(n);
    return n;
  }
  let bannerEl = null;
  function applyBanner(cfg) {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
    if (cfg.banner && cfg.bannerId !== seenBanner) {
      bannerEl = showNote(cfg.banner, "kg-banner", () => {
        seenBanner = cfg.bannerId;
        try { localStorage.setItem("kg_banner", String(seenBanner)); } catch (e) {}
      });
    }
  }

  let lastBannerId = -1;
  function apply(res) {
    if (!res) return;
    if (res.cfg) {
      KG.cfg = res.cfg;
      if (reloadNonce === null) reloadNonce = res.cfg.reload;
      else if (res.cfg.reload !== reloadNonce) { location.reload(); return; }
      if (res.cfg.bannerId !== lastBannerId) { lastBannerId = res.cfg.bannerId; applyBanner(res.cfg); }
    }
    if (res.blocked) {
      KG.locked = true;
      showLock("🚫", "دسترسی محدود شده", "دسترسی شما به این سایت محدود شده است.");
    } else if (res.cfg && res.cfg.maintenance) {
      KG.locked = true;
      showLock("🛠", "سایت در حال به‌روزرسانی است", res.cfg.maintenanceText || "به‌زودی برمی‌گردیم 💛");
    } else if (KG.locked) {
      KG.locked = false;
      hideLock();
    }
    if (res.msg && res.msg.text) showNote("💬 " + res.msg.text, "kg-dm");
    if (res.need === "visit") sendVisit();
  }

  async function sendVisit() {
    try {
      const d = await collect();
      apply(await post({ t: "visit", d }));
      visited = true;
    } catch (e) {}
  }

  function event(type, data) {
    try {
      const body = Object.assign({ t: type }, data || {});
      post(body).then(apply);
    } catch (e) {}
  }

  function heartbeat() {
    if (!visited) return;
    let st = "menu", sc = 0;
    try { if (KG.getState) { const s = KG.getState(); st = s.state; sc = s.score; } } catch (e) {}
    post({ t: "hb", st, sc }).then(apply);
  }

  function init() {
    sendVisit();
    setInterval(heartbeat, 15000);
    window.addEventListener("pagehide", () => post({ t: "end" }, true));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
