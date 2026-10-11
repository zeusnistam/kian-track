"use strict";
// Lightweight user-agent + client-hints parser (device model is approximate).

const IPHONES = [
  [320, 568, 2, "iPhone 5s / SE (1st)"], [375, 667, 2, "iPhone 6/7/8 / SE (2nd-3rd)"],
  [414, 736, 3, "iPhone 6/7/8 Plus"], [375, 812, 3, "iPhone X/XS/11 Pro/12 mini/13 mini"],
  [414, 896, 2, "iPhone XR / 11"], [414, 896, 3, "iPhone XS Max / 11 Pro Max"],
  [390, 844, 3, "iPhone 12/13/14 (Pro)"], [428, 926, 3, "iPhone 12/13 Pro Max / 14 Plus"],
  [393, 852, 3, "iPhone 14 Pro / 15 / 15 Pro / 16"], [430, 932, 3, "iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus"],
  [402, 874, 3, "iPhone 16 Pro / 17 Pro"], [440, 956, 3, "iPhone 16 Pro Max / 17 Pro Max"],
  [420, 912, 3, "iPhone Air"],
];

function androidBrand(m) {
  if (!m) return "";
  if (/^(SM-|SAMSUNG|GT-|SC-|SCV)/i.test(m)) return "Samsung";
  if (/^Pixel/i.test(m)) return "Google";
  if (/^(Redmi|POCO|Mi |MI |M\d{4}|\d{4}[A-Z]{2,}\d?[A-Z]?$|2\d{3}\d{2}[A-Z]{2})/i.test(m)) return "Xiaomi";
  if (/^(CPH|OPPO|PH[A-Z]M)/i.test(m)) return "OPPO";
  if (/^(RMX|realme)/i.test(m)) return "realme";
  if (/^(V\d{4}|vivo|PD\d{4})/i.test(m)) return "vivo";
  if (/^(ONEPLUS|IN20|KB20|LE2|CPH2|NE22|PJ[A-Z]\d)/i.test(m)) return "OnePlus";
  if (/^(HUAWEI|[A-Z]{3}-[AL]\d{2}|ELS-|ANA-|NOH-|LYA-|VOG-|MAR-|JNY-|CLT-|EML-|STK-|JSN-)/i.test(m)) return "Huawei";
  if (/^(HONOR|NTH-|ELP-|PGT-|REA-)/i.test(m)) return "Honor";
  if (/^(TECNO|Tecno|K[A-Z]\d)/i.test(m)) return "Tecno";
  if (/^(Infinix|X6\d{3})/i.test(m)) return "Infinix";
  if (/^(moto|XT\d{4})/i.test(m)) return "Motorola";
  if (/^(Nokia|TA-\d)/i.test(m)) return "Nokia";
  if (/^(LG|LM-)/i.test(m)) return "LG";
  if (/^(SO-|Xperia|XQ-)/i.test(m)) return "Sony";
  if (/^(ASUS|ZS\d|AI2)/i.test(m)) return "ASUS";
  return "";
}

function parseUA(ua, ch, scr) {
  ua = String(ua || "");
  ch = ch || {};
  scr = scr || {};
  const r = { type: "desktop", brand: "", model: "", os: "", osv: "", browser: "", bv: "", approx: false, bot: false };
  if (/bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|monitor|uptime|curl\/|wget|python-requests|axios|go-http|node-fetch|okhttp\/\d.*bot/i.test(ua)) r.bot = true;

  let m;
  const touch = Number(scr.touch) || 0;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) {
    r.os = /iPad/.test(ua) || /Macintosh/.test(ua) ? "iPadOS" : "iOS";
    if ((m = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))?/))) r.osv = m[1] + "." + m[2];
    r.brand = "Apple";
    if (/iPad|Macintosh/.test(ua)) { r.type = "tablet"; r.model = "iPad"; }
    else {
      r.type = "mobile";
      const w = Math.min(Number(scr.sw) || 0, Number(scr.sh) || 0);
      const h = Math.max(Number(scr.sw) || 0, Number(scr.sh) || 0);
      const dpr = Math.round(Number(scr.dpr) || 0);
      const f = IPHONES.find((x) => x[0] === w && x[1] === h && x[2] === dpr) || IPHONES.find((x) => x[0] === w && x[1] === h);
      r.model = f ? f[3] : "iPhone";
      r.approx = true;
    }
  } else if (/Android/i.test(ua)) {
    r.os = "Android";
    if ((m = ua.match(/Android[ /]?([\d.]+)/i))) r.osv = m[1];
    r.type = /Mobile/i.test(ua) ? "mobile" : "tablet";
    let model = "";
    if ((m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\)|;)/i))) model = m[1].trim();
    if (ch.model) model = String(ch.model);
    if (/^(K|U|wv|Mobile|Linux|Android)$/i.test(model)) model = "";
    if (ch.pv && /^\d+/.test(ch.pv)) r.osv = String(ch.pv).split(".").slice(0, 2).join(".");
    r.model = model;
    r.brand = androidBrand(model);
    r.approx = !ch.model;
  } else if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    r.os = "Windows";
    const pv = parseInt(ch.pv, 10);
    r.osv = m[1] === "10.0" ? (pv >= 13 ? "11" : "10/11") : m[1] === "6.3" ? "8.1" : m[1] === "6.1" ? "7" : m[1];
  } else if (/CrOS/.test(ua)) { r.os = "ChromeOS"; }
  else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) { r.os = "macOS"; r.osv = m[1].replace(/_/g, ".").split(".").slice(0, 2).join("."); }
  else if (/Linux|X11/.test(ua)) { r.os = "Linux"; }
  else if (/Tizen|SmartTV|WebOS|HbbTV/i.test(ua)) { r.os = "Smart TV"; r.type = "tv"; }

  // Browser (order matters)
  const B = [
    [/Instagram ([\d.]+)/, "Instagram (in-app)"], [/FBAN|FBAV|FB_IAB/, "Facebook (in-app)"],
    [/Telegram/i, "Telegram (in-app)"], [/Line\/([\d.]+)/, "LINE (in-app)"],
    [/EdgA?\/([\d.]+)|Edg\/([\d.]+)|EdgiOS\/([\d.]+)/, "Edge"], [/OPR\/([\d.]+)|OPiOS\/([\d.]+)|Opera/, "Opera"],
    [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"], [/YaBrowser\/([\d.]+)/, "Yandex"],
    [/UCBrowser\/([\d.]+)/, "UC Browser"], [/Vivaldi\/([\d.]+)/, "Vivaldi"],
    [/(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox"], [/(?:Chrome|CriOS)\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ];
  for (const [re, name] of B) {
    const mm = ua.match(re);
    if (mm) { r.browser = name; r.bv = (mm.slice(1).find(Boolean) || "").split(".")[0]; break; }
  }
  if (!r.browser && /Safari/.test(ua)) r.browser = "Safari";
  if (r.type === "desktop" && ch.mobile === true) r.type = "mobile";
  if (!r.os && ch.platform) r.os = String(ch.platform);
  return r;
}

module.exports = { parseUA };
