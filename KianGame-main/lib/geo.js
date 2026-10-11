"use strict";
// IP -> country / city / ISP lookup (free services, no API key), cached.
const net = require("net");
const { log } = require("./util");

const IP_API = process.env.GEO_API || "http://ip-api.com";
const cache = new Map();
const inflight = new Map();
const TTL = 24 * 3600 * 1000;
const MAX = 5000;

function isPrivate(ip) {
  if (!net.isIP(ip)) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

async function getJson(url, ms = 3500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function fetchGeo(ip) {
  try {
    const j = await getJson(`${IP_API}/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,proxy,hosting,mobile`);
    if (j && j.status === "success") {
      return {
        cc: j.countryCode || "", country: j.country || "", region: j.regionName || "", city: j.city || "",
        lat: j.lat, lon: j.lon, tz: j.timezone || "", isp: j.isp || j.org || "",
        proxy: !!(j.proxy || j.hosting), mobile: !!j.mobile,
      };
    }
  } catch (e) { /* fall through to backup */ }
  try {
    const j = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
    if (j && j.success) {
      return {
        cc: j.country_code || "", country: j.country || "", region: j.region || "", city: j.city || "",
        lat: j.latitude, lon: j.longitude, tz: (j.timezone && j.timezone.id) || "",
        isp: (j.connection && (j.connection.isp || j.connection.org)) || "", proxy: false, mobile: false,
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function peek(ip) {
  const c = cache.get(ip);
  return c && Date.now() - c.t < TTL ? c.data : null;
}

async function lookup(ip) {
  if (!ip) return {};
  if (isPrivate(ip)) return { cc: "", country: "Local / Private", city: "", region: "", isp: "" };
  const hit = peek(ip);
  if (hit) return hit;
  if (inflight.has(ip)) return inflight.get(ip);
  const p = (async () => {
    const data = await fetchGeo(ip);
    if (data) {
      if (cache.size >= MAX) cache.delete(cache.keys().next().value);
      cache.set(ip, { t: Date.now(), data });
      return data;
    }
    log("geo lookup failed for", ip);
    return {};
  })().finally(() => inflight.delete(ip));
  inflight.set(ip, p);
  return p;
}

module.exports = { lookup, peek, isPrivate, size: () => cache.size };
