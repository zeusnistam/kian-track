// Simple static web server for "بازی کیان پوری" (Kianpori Game)
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const core = require("./lib/core");
const geo = require("./lib/geo");
const store = require("./lib/store");
const bot = require("./lib/bot");
const { log } = require("./lib/util");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg"]);
const REVALIDATE = new Set([".html", ".js", ".css", ".webmanifest", ".json"]);
const NO_CACHE = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico"]);
const gzipCache = new Map();

function send(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "404 Not Found");

    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": contentType,
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": NO_CACHE.has(ext) ? "no-cache" : REVALIDATE.has(ext) ? "no-cache" : "public, max-age=604800",
      "X-Content-Type-Options": "nosniff",
    };

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      let [startStr, endStr] = range.replace("bytes=", "").split("-");
      let start, end;
      if (startStr === "") {
        const n = parseInt(endStr, 10);
        start = Math.max(stat.size - n, 0);
        end = stat.size - 1;
      } else {
        start = parseInt(startStr, 10);
        end = endStr === "" ? stat.size - 1 : Math.min(parseInt(endStr, 10), stat.size - 1);
      }
      if (!(start <= end) || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    }

    const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    if (COMPRESSIBLE.has(ext) && wantsGzip) {
      const cached = gzipCache.get(filePath);
      const sendGz = (buf) => {
        res.writeHead(200, {
          ...headers,
          "Content-Encoding": "gzip",
          Vary: "Accept-Encoding",
          "Content-Length": buf.length,
        });
        res.end(req.method === "HEAD" ? undefined : buf);
      };
      if (cached && cached.etag === etag) return sendGz(cached.buf);
      return fs.readFile(filePath, (e, data) => {
        if (e) return res.destroy();
        zlib.gzip(data, { level: 9 }, (e2, buf) => {
          if (e2) return res.destroy();
          gzipCache.set(filePath, { etag, buf });
          sendGz(buf);
        });
      });
    }

    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Helpers for the tracking API / protection pages
// ---------------------------------------------------------------------------
function clientIp(req) {
  let ip = String(req.headers["x-real-ip"] || "").trim();
  if (!ip) ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (!ip) ip = req.socket.remoteAddress || "";
  ip = ip.replace(/^::ffff:/i, "");
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("too big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const rate = new Map(); // ip -> {n, t}
function limited(ip) {
  const now = Date.now();
  let r = rate.get(ip);
  if (!r || now - r.t > 60000) { r = { n: 0, t: now }; rate.set(ip, r); }
  r.n++;
  return r.n > 120;
}
setInterval(() => { const now = Date.now(); for (const [k, r] of rate) if (now - r.t > 60000) rate.delete(k); }, 60000).unref();

function pageHtml(icon, title, text) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>html,body{margin:0;height:100%;background:#0e1116;color:#f4f4f4;font-family:Vazirmatn,Tahoma,sans-serif}
body{display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}.c{max-width:420px}.i{font-size:64px}h1{font-size:24px;margin:12px 0 8px}p{opacity:.8;line-height:1.9;margin:0}</style></head>
<body><div class="c"><div class="i">${icon}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div></body></html>`;
}
function sendPage(req, res, code, html, extra = {}) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(req.method === "HEAD" ? undefined : html);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleApi(req, res, ip) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false });
  if (limited(ip)) return sendJson(res, 429, { ok: false });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false }); }
  const hdrCc = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  try {
    const out = await core.handleTrack(ip, String(req.headers["user-agent"] || ""), body, /^[A-Z]{2}$/.test(hdrCc) ? hdrCc : "");
    return sendJson(res, 200, out);
  } catch (e) {
    log("track error:", e && e.stack ? e.stack : e);
    return sendJson(res, 200, { ok: false });
  }
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    return send(res, 400, "Bad Request");
  }

  if (url === "/healthz") return send(res, 200, "ok");
  if (url.includes("\0")) return send(res, 400, "Bad Request");

  const ip = clientIp(req);

  if (url === "/api/track") {
    handleApi(req, res, ip).catch((e) => { log("api error:", e.message); try { sendJson(res, 500, { ok: false }); } catch (e2) {} });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");

  const isPage = !path.extname(url) || url === "/index.html";
  if (isPage) {
    const hdrCc = String(req.headers["cf-ipcountry"] || "").toUpperCase();
    const cached = geo.peek(ip);
    const cc = (cached && cached.cc) || hdrCc;
    if (core.isBanned(ip, cc)) return sendPage(req, res, 403, pageHtml("🚫", "دسترسی محدود شده", "دسترسی شما به این سایت محدود شده است."));
    if (store.db.config.maintenance) {
      return sendPage(req, res, 503, pageHtml("🛠", "سایت در حال به‌روزرسانی است", store.db.config.maintenanceText || "به‌زودی برمی‌گردیم. ممنون از صبرتون 💛"), { "Retry-After": "300" });
    }
  }

  const safePath = path.normalize(path.join(PUBLIC_DIR, url));
  if (safePath !== PUBLIC_DIR && !safePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 404, "404 Not Found");
  }

  fs.stat(safePath, (err, stat) => {
    if (!err && stat.isFile()) return serveFile(req, res, safePath);

    if (path.extname(url)) return send(res, 404, "404 Not Found");
    serveFile(req, res, path.join(PUBLIC_DIR, "index.html"));
  });
});

// Railway's proxy keeps connections open; make sure Node doesn't close them first (avoids random 502s)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, () => {
  log(`Kianpori Game web server running on port ${PORT}`);
  log(`Data directory: ${store.DATA_DIR}`);
  bot.start().catch((e) => log("bot start error:", e.message));
});

// ---------------------------------------------------------------------------
// Never crash on a stray error; save data on shutdown (Railway sends SIGTERM on every deploy)
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (e) => log("unhandledRejection:", e && e.message ? e.message : e));
process.on("uncaughtException", (e) => log("uncaughtException:", e && e.stack ? e.stack : e));
function shutdown() {
  log("shutting down, saving data…");
  try { bot.stop(); store.flushSync(); } catch (e) {}
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
