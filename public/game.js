/* =========================================================================
   بازی کیان پوری — Web Edition
   A canvas port of the original Pygame game. Runs at a fixed 1100x500
   "virtual" resolution that is scaled with CSS to fit any screen, and
   auto-detects touch/mobile devices to enlarge UI and enable touch input.
   ========================================================================= */

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Device detection
  // ---------------------------------------------------------------------
  // "coarse" = the main input is a finger (phones/tablets). Laptops with a
  // touchscreen still have a mouse/trackpad as main input, so they keep the
  // desktop layout (touch taps on the canvas keep working anyway).
  const IS_TOUCH = window.matchMedia("(pointer: coarse)").matches;
  const IS_NARROW = Math.min(window.innerWidth, window.innerHeight) < 620;
  const IS_MOBILE = IS_TOUCH || IS_NARROW;
  document.body.classList.toggle("is-mobile", IS_MOBILE);

  // ---------------------------------------------------------------------
  // Canvas setup (fixed virtual resolution, matches the original game)
  // ---------------------------------------------------------------------
  const WIDTH = 1100;
  const HEIGHT = 500;
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.direction = "rtl";

  function fitCanvasToDPR() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Resizing a canvas wipes it and resets the context, so only do it when
    // the pixel ratio really changed (mobile fires "resize" constantly).
    if (canvas.width !== Math.round(WIDTH * dpr)) {
      canvas.width = Math.round(WIDTH * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.direction = "rtl";
  }
  fitCanvasToDPR();
  window.addEventListener("resize", fitCanvasToDPR);
  window.addEventListener("orientationchange", () => setTimeout(fitCanvasToDPR, 200));

  // ---------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------
  const IMG_BASE = "/assets/images/";
  // Bump this number whenever you replace an image. Browsers that cached an
  // old picture (the first server version cached images for 7 days) are then
  // forced to download the new one instead of showing the stale copy.
  const IMG_VER = "?v=20261005";
  const SND_BASE = "/assets/audio/";

  let booted = false;
  // Tries each file extension in turn (webp first, then the original png/jpg),
  // so it works whichever format you drop into assets/images.
  function loadImage(name, exts) {
    const im = new Image();
    im.decoding = "async";
    let i = 0;
    // repaint the static frame behind the start overlay once images arrive
    im.onload = () => {
      if (!booted && typeof render === "function") render(0);
    };
    im.onerror = () => {
      i += 1;
      if (i < exts.length) im.src = IMG_BASE + name + "." + exts[i] + IMG_VER;
    };
    im.src = IMG_BASE + name + "." + exts[0] + IMG_VER;
    return im;
  }
  // A broken image is "complete" too but has no size, and drawing it throws.
  const ready = (im) => !!im && im.complete && im.naturalWidth > 0;

  const images = {
    cloud: loadImage("cloud", ["webp", "png"]),
    cactus: loadImage("cac", ["webp", "png"]),
    dino: loadImage("Sar", ["webp", "png"]),
    headNormal: loadImage("head_normal", ["webp", "png"]),
    headSilver: loadImage("head_noghre", ["webp", "png"]),
    headGold: loadImage("head_gold", ["webp", "png"]),
    goldWin: loadImage("gold_win", ["webp", "jpg"]),
    silverWin: loadImage("score20", ["webp", "jpg"]),
  };

  function makeSound(name, { volume = 1, loop = false } = {}) {
    const a = new Audio(SND_BASE + name);
    a.preload = "auto";
    a.loop = loop;
    a.volume = volume;
    return a;
  }

  const sounds = {
    main: makeSound("music.mp3", { loop: true }),
    lose: makeSound("lose.mp3"),
    clap: makeSound("clap.mp3"),
    main2: makeSound("main2.mp3", { loop: true }),
    coin: makeSound("coin.mp3", { volume: 0.8 }),
    shield: makeSound("shild.mp3", { volume: 0.3 }),
  };

  function playFresh(snd) {
    try {
      snd.currentTime = 0;
      snd.play().catch(() => {});
    } catch (e) {}
  }
  function stopSound(snd) {
    try {
      snd.pause();
      snd.currentTime = 0;
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Persisted data
  // ---------------------------------------------------------------------
  const HS_KEY = "kianpori_highscore";
  const MUTE_KEY = "kianpori_muted";
  function loadHighscore() {
    try {
      const v = parseInt(localStorage.getItem(HS_KEY) || "0", 10);
      return Number.isFinite(v) ? v : 0;
    } catch (e) {
      return 0; // storage blocked (private mode) - don't crash the game
    }
  }
  function saveHighscore(v) {
    try {
      localStorage.setItem(HS_KEY, String(v));
    } catch (e) {}
  }
  let highscore = loadHighscore();
  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_KEY) === "1";
  } catch (e) {}

  // NOTE: iPhones ignore audio.volume (it is read-only there), so mute has to
  // use audio.muted or the sound button would do nothing on iOS.
  function applyMute() {
    for (const k in sounds) sounds[k].muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch (e) {}
  }
  applyMute();

  // iOS/Safari only lets a sound play later (coin, lose, ...) if it was
  // "touched" once inside a real tap. Do that silently on the first tap.
  function unlockAudio() {
    for (const k in sounds) {
      if (k === "main") continue; // the music itself is started by the tap
      const a = sounds[k];
      try {
        a.muted = true;
        const pr = a.play();
        const restore = () => {
          a.pause();
          a.currentTime = 0;
          a.muted = muted;
        };
        if (pr && pr.then) pr.then(restore).catch(() => { a.muted = muted; });
        else restore();
      } catch (e) {
        a.muted = muted;
      }
    }
  }

  const CARD_NUMBER = "6104 3375 1296 9740";

  // ---------------------------------------------------------------------
  // Game states
  // ---------------------------------------------------------------------
  const STATE_MENU = "menu";
  const STATE_PLAYING = "playing";
  const STATE_PAUSED = "paused";
  const STATE_GAMEOVER = "gameover";
  const STATE_SUPPORT = "support";
  const STATE_MILESTONE = "milestone"; // in-canvas replacement for the blocking tkinter popup

  let state = STATE_MENU;
  let menuTime = 0;
  let toastTimer = 0;
  let toastText = "";

  const DINO_X = 80;
  const GROUND_REST_Y = 300;
  let dino = { x: DINO_X, y: GROUND_REST_Y, w: 20, h: 60 };
  let velY = 0;
  let isDucking = false;

  let obstacles = [];
  let coins = [];
  let particles = [];
  let score = 0;
  const BASE_SPEED = 8.0;
  let shieldCharges = 0;
  let flashTimer = 0;
  let milestonesHit = new Set();
  let milestoneInfo = null; // {image, title, text}
  let pendingReturnState = STATE_PLAYING;

  // remote control (set from the Telegram admin panel through /api/track)
  function kgCfg() {
    return (window.KG && window.KG.cfg) || {};
  }
  function kgSpeed() {
    const m = Number(kgCfg().speedMul);
    return m >= 0.5 && m <= 2 ? m : 1;
  }
  function kgShield() {
    const n = Math.floor(Number(kgCfg().startShield));
    return n >= 1 ? Math.min(n, 2) : 0;
  }
  function kgEvent(type, data) {
    try { if (window.KG) window.KG.event(type, data); } catch (e) {}
  }

  function currentSpeed() {
    return Math.min(BASE_SPEED + score * 0.08, BASE_SPEED + 12) * kgSpeed();
  }

  // one place that starts a run: never leaves two songs playing together
  function startGame() {
    resetGame();
    stopSound(sounds.main);
    stopSound(sounds.main2);
    playFresh(sounds.main);
    state = STATE_PLAYING;
    kgEvent("play");
  }

  function resetGame() {
    dino = { x: DINO_X, y: GROUND_REST_Y, w: 20, h: 60 };
    velY = 0;
    isDucking = false;
    obstacles = [{ x: 1100.0, y: 310, w: 25, h: 40, type: "ground" }];
    coins = [];
    particles = [];
    score = 0;
    shieldCharges = kgShield();
    flashTimer = 0;
    milestonesHit = new Set();
  }
  resetGame();

  function spawnParticles(x, y, color, n = 14) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x,
        y,
        vx: rand(-3, 3),
        vy: rand(-5, -1),
        life: Math.floor(rand(20, 40)),
        color,
      });
    }
  }
  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.25;
      p.life -= 1;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }
  function drawParticles() {
    for (const p of particles) {
      const alpha = Math.max(0, Math.min(255, p.life * 8)) / 255;
      ctx.fillStyle = `rgba(${p.color[0]},${p.color[1]},${p.color[2]},${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }
  function randInt(a, b) {
    return Math.floor(rand(a, b + 1));
  }

  function dinoHitbox() {
    if (isDucking && dino.y >= GROUND_REST_Y) {
      return { x: DINO_X, y: 330, w: 20, h: 30 };
    }
    return { x: DINO_X, y: dino.y, w: 20, h: 60 };
  }
  function rectsCollide(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function bgColorForScore(s) {
    const stops = [0, 20, 50, 120];
    const colors = [
      [255, 255, 255],
      [255, 244, 214],
      [255, 214, 163],
      [215, 222, 240],
    ];
    if (s <= stops[0]) return colors[0];
    if (s >= stops[stops.length - 1]) return colors[colors.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (stops[i] <= s && s <= stops[i + 1]) {
        const t = (s - stops[i]) / (stops[i + 1] - stops[i]);
        const c1 = colors[i];
        const c2 = colors[i + 1];
        return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
      }
    }
    return colors[colors.length - 1];
  }

  const CLOUDS_BG = [
    [250, 50],
    [500, 90],
    [850, 40],
    [30, 70],
    [650, 57],
  ];

  function showToast(text) {
    toastText = text;
    toastTimer = 90;
  }

  // ---------------------------------------------------------------------
  // Milestones (replaces the blocking tkinter popup with a non-blocking
  // in-canvas overlay — the original froze the whole game window here,
  // which is not something we want to reproduce)
  // ---------------------------------------------------------------------
  function triggerMilestone(kind) {
    stopSound(sounds.main);
    stopSound(sounds.main2);
    playFresh(sounds.clap);
    if (kind === "silver") {
      milestoneInfo = {
        image: images.silverWin,
        title: "تبریک!",
        text: "شما برنده ۲۰ تا کیانپوری نقره‌ای شدید!",
        resume: "main",
      };
    } else {
      milestoneInfo = {
        image: images.goldWin,
        title: "تبریک!",
        text: "شما برنده ۵۰ تا کیانپوری طلایی شدید!!",
        resume: "main2",
      };
    }
    pendingReturnState = STATE_PLAYING;
    state = STATE_MILESTONE;
  }
  function dismissMilestone() {
    if (!milestoneInfo) return;
    if (milestoneInfo.resume === "main2") {
      playFresh(sounds.main2);
    } else {
      playFresh(sounds.main);
    }
    milestoneInfo = null;
    state = pendingReturnState;
  }

  // ---------------------------------------------------------------------
  // Layout: two variants (desktop / mobile) so buttons stay easily
  // tappable and text stays legible once the canvas is scaled down to
  // fit a phone screen.
  // ---------------------------------------------------------------------
  function rect(x, y, w, h) {
    return { x, y, w, h };
  }

  const L = IS_MOBILE
    ? {
        titleSize: 58,
        btnFontSize: 30,
        medSize: 24,
        smallSize: 19,
        menuStart: rect(40, 205, 460, 108),
        menuSupport: rect(40, 328, 460, 90),
        menuMute: rect(40, 432, 230, 40),
        supportCard: rect(40, 195, 560, 96),
        supportBack: rect(40, 410, 220, 72),
        pauseResume: rect(WIDTH / 2 - 190, 235, 380, 84),
        pauseMenu: rect(WIDTH / 2 - 190, 335, 380, 84),
        gameoverRestart: rect(WIDTH / 2 - 190, 255, 380, 84),
        gameoverMenu: rect(WIDTH / 2 - 190, 355, 380, 84),
        milestoneBtn: rect(WIDTH / 2 - 150, 420, 300, 66),
      }
    : {
        titleSize: 54,
        btnFontSize: 26,
        medSize: 22,
        smallSize: 18,
        menuStart: rect(60, 235, 280, 62),
        menuSupport: rect(60, 315, 280, 62),
        menuMute: rect(60, 400, 150, 42),
        supportCard: rect(60, 195, 420, 80),
        supportBack: rect(60, 400, 160, 50),
        pauseResume: rect(WIDTH / 2 - 130, 250, 260, 55),
        pauseMenu: rect(WIDTH / 2 - 130, 320, 260, 55),
        gameoverRestart: rect(WIDTH / 2 - 130, 270, 260, 55),
        gameoverMenu: rect(WIDTH / 2 - 130, 340, 260, 55),
        milestoneBtn: rect(WIDTH / 2 - 120, 400, 240, 56),
      };

  const fontTitle = () => `800 ${L.titleSize}px Vazirmatn, Tahoma, sans-serif`;
  const fontBtn = () => `700 ${L.btnFontSize}px Vazirmatn, Tahoma, sans-serif`;
  const fontMed = () => `500 ${L.medSize}px Vazirmatn, Tahoma, sans-serif`;
  const fontSmall = () => `400 ${L.smallSize}px Vazirmatn, Tahoma, sans-serif`;

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function drawButton(r, label, icon, hover) {
    ctx.save();
    const alpha = hover ? 0.92 : 0.75;
    roundRect(r.x, r.y, r.w, r.h, 14);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.stroke();

    const iconCX = r.x + 34;
    const iconCY = r.y + r.h / 2;
    if (icon === "play") {
      ctx.fillStyle = "#1e1e1e";
      ctx.beginPath();
      ctx.moveTo(iconCX - 9, iconCY - 12);
      ctx.lineTo(iconCX - 9, iconCY + 12);
      ctx.lineTo(iconCX + 13, iconCY);
      ctx.closePath();
      ctx.fill();
    } else if (icon === "heart") {
      ctx.fillStyle = "rgb(220,60,90)";
      ctx.beginPath();
      ctx.arc(iconCX - 7, iconCY - 4, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(iconCX + 7, iconCY - 4, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(iconCX - 15, iconCY - 2);
      ctx.lineTo(iconCX + 15, iconCY - 2);
      ctx.lineTo(iconCX, iconCY + 15);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = "#191919";
    ctx.font = fontBtn();
    ctx.direction = "rtl";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(label, r.x + r.w - 22, r.y + r.h / 2 + 1);
    ctx.restore();
  }

  function roundRect(x, y, w, h, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  // ---------------------------------------------------------------------
  // Scene drawing
  // ---------------------------------------------------------------------
  function drawScene(animate, t) {
    const bg = bgColorForScore(state !== STATE_MENU ? score : 0);
    ctx.fillStyle = `rgb(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    for (let i = 0; i < CLOUDS_BG.length; i++) {
      const [cx, cy] = CLOUDS_BG[i];
      const offset = animate ? Math.sin(t / 40 + i) * 4 : 0;
      if (ready(images.cloud)) ctx.drawImage(images.cloud, cx, cy + offset, 150, 150);
    }

    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 350);
    ctx.lineTo(WIDTH, 350);
    ctx.stroke();

    for (const c of coins) {
      const cx = c.x,
        cy = c.y;
      const pulse = 2 + Math.sin(t / 6 + c.x) * 2;
      ctx.fillStyle = "rgb(255,221,90)";
      ctx.beginPath();
      ctx.arc(cx, cy, 9 + pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgb(255,195,20)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 9 + pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const o of obstacles) {
      const ox = o.x;
      if (o.type === "ground") {
        if (ready(images.cactus)) ctx.drawImage(images.cactus, ox, o.y - 36, 150, 80);
      } else {
        if (ready(images.cloud)) {
          ctx.save();
          ctx.filter = "brightness(0.75) saturate(0.6)";
          ctx.drawImage(images.cloud, ox - 25, o.y - 15, 95, 60);
          ctx.restore();
        }
      }
    }

    const bob = animate && state === STATE_MENU ? Math.sin(t / 15) * 4 : 0;
    if (isDucking && dino.y >= GROUND_REST_Y && state !== STATE_MENU) {
      if (ready(images.dino)) ctx.drawImage(images.dino, dino.x - 5, 322, 130, 42);
    } else {
      if (ready(images.dino)) ctx.drawImage(images.dino, dino.x, dino.y - 15 + bob, 120, 75);
    }

    if (shieldCharges > 0 && state === STATE_PLAYING) {
      ctx.save();
      ctx.strokeStyle = "rgba(80,170,255,0.5)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(dino.x + 61, dino.y - 37 + 60, 45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgb(30,90,200)";
      ctx.font = fontSmall();
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`x${shieldCharges}`, dino.x + 25, dino.y - 25);
    }

    drawParticles();

    let headImg = images.headNormal;
    if (score >= 50) headImg = images.headGold;
    else if (score >= 20) headImg = images.headSilver;
    if (ready(headImg)) ctx.drawImage(headImg, 870, 7, 90, 65);

    ctx.fillStyle = "black";
    ctx.font = `26px Vazirmatn, Tahoma, sans-serif`;
    ctx.direction = "ltr";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("score: " + score, 950, 30);
    ctx.fillStyle = "rgb(90,90,90)";
    ctx.font = `16px Vazirmatn, Tahoma, sans-serif`;
    ctx.fillText("best: " + highscore, 950, 58);
    ctx.direction = "rtl";

    if (flashTimer > 0) {
      ctx.fillStyle = `rgba(255,0,0,${(0.47 * flashTimer) / 12})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
  }

  function drawGlowTitle(text, x, y, glowColor = "rgba(255,255,255,0.5)") {
    ctx.save();
    ctx.font = fontTitle();
    ctx.direction = "rtl";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 18;
    ctx.fillStyle = "white";
    ctx.fillText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawMenuFade() {
    const grad = ctx.createLinearGradient(0, 0, 700, 0);
    grad.addColorStop(0, "rgba(0,0,0,0.85)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 700, HEIGHT);
  }

  function render(t) {
    if (state === STATE_MENU) {
      drawScene(true, menuTime);
      drawMenuFade();
      drawGlowTitle("بازی کیان پوری", 20, 50);

      ctx.font = fontMed();
      ctx.direction = "rtl";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "white";
      ctx.fillText("بهترین امتیاز: " + highscore, 60, 180);

      drawButton(L.menuStart, "شروع بازی", "play", pointInRect(mouse.x, mouse.y, L.menuStart));
      drawButton(L.menuSupport, "حمایت", "heart", pointInRect(mouse.x, mouse.y, L.menuSupport));

      const hoverMute = pointInRect(mouse.x, mouse.y, L.menuMute);
      roundRect(L.menuMute.x, L.menuMute.y, L.menuMute.w, L.menuMute.h, 8);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (hoverMute) {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fill();
      }
      ctx.font = fontSmall();
      ctx.fillStyle = "white";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(muted ? "صدا: خاموش" : "صدا: روشن", L.menuMute.x + L.menuMute.w - 12, L.menuMute.y + L.menuMute.h / 2 + 1);

      ctx.font = fontSmall();
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const hint = IS_MOBILE
        ? "لمس کن تا بپری  |  دکمه «خم شو» برای خم شدن"
        : "Space یا Enter برای شروع سریع  |  M برای قطع صدا";
      const hintY = IS_MOBILE ? L.menuMute.y + L.menuMute.h + 6 : HEIGHT - 42;
      ctx.fillText(hint, 60, hintY);
    } else if (state === STATE_SUPPORT) {
      drawScene(true, menuTime);
      drawMenuFade();
      drawGlowTitle("حمایت", 55, 50);

      const hoverCard = pointInRect(mouse.x, mouse.y, L.supportCard);
      roundRect(L.supportCard.x, L.supportCard.y, L.supportCard.w, L.supportCard.h, 14);
      ctx.fillStyle = hoverCard ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.78)";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = fontSmall();
      ctx.direction = "rtl";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgb(110,110,110)";
      ctx.fillText("برای کپی کلیک کن", L.supportCard.x + 20, L.supportCard.y + 12);

      ctx.direction = "ltr";
      ctx.font = fontBtn();
      ctx.fillStyle = "rgb(25,25,25)";
      ctx.fillText(CARD_NUMBER, L.supportCard.x + 20, L.supportCard.y + 40);
      ctx.direction = "rtl";

      drawButton(L.supportBack, "بازگشت", "none", pointInRect(mouse.x, mouse.y, L.supportBack));

      if (toastTimer > 0) {
        ctx.font = fontMed();
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgb(40,160,90)";
        ctx.fillText(toastText, L.supportCard.x, L.supportCard.y + L.supportCard.h + 15);
      }
    } else if (
      state === STATE_PLAYING ||
      state === STATE_PAUSED ||
      state === STATE_GAMEOVER ||
      state === STATE_MILESTONE
    ) {
      drawScene(state === STATE_PLAYING, menuTime);

      if (state === STATE_PAUSED) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.font = fontTitle();
        ctx.direction = "rtl";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "white";
        ctx.fillText("مکث", WIDTH / 2, 100);
        drawButton(L.pauseResume, "ادامه بازی", "play", pointInRect(mouse.x, mouse.y, L.pauseResume));
        drawButton(L.pauseMenu, "منو", "none", pointInRect(mouse.x, mouse.y, L.pauseMenu));
      }

      if (state === STATE_GAMEOVER) {
        ctx.fillStyle = "rgba(0,0,0,0.58)";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.font = fontTitle();
        ctx.direction = "rtl";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.shadowColor = "rgba(255,90,90,0.6)";
        ctx.shadowBlur = 16;
        ctx.fillStyle = "white";
        ctx.fillText("باختی!", WIDTH / 2, 65);
        ctx.shadowBlur = 0;

        ctx.font = fontMed();
        ctx.fillText(`امتیاز: ${score}    بهترین: ${highscore}`, WIDTH / 2, 190);

        drawButton(L.gameoverRestart, "ری استارت", "play", pointInRect(mouse.x, mouse.y, L.gameoverRestart));
        drawButton(L.gameoverMenu, "منو", "none", pointInRect(mouse.x, mouse.y, L.gameoverMenu));
      }

      if (state === STATE_MILESTONE && milestoneInfo) {
        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        const imgW = 220,
          imgH = 220;
        const img = milestoneInfo.image;
        if (ready(img)) {
          const ix = WIDTH / 2 - imgW / 2;
          const iy = 60;
          roundRect(ix, iy, imgW, imgH, 16);
          ctx.save();
          ctx.clip();
          ctx.drawImage(img, ix, iy, imgW, imgH);
          ctx.restore();
        }

        ctx.font = fontTitle();
        ctx.direction = "rtl";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgb(255,210,63)";
        ctx.fillText(milestoneInfo.title, WIDTH / 2, 300);

        ctx.font = fontMed();
        ctx.fillStyle = "white";
        ctx.fillText(milestoneInfo.text, WIDTH / 2, 350);

        drawButton(L.milestoneBtn, "ادامه", "play", pointInRect(mouse.x, mouse.y, L.milestoneBtn));
      }
    }
  }

  // ---------------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------------
  const mouse = { x: -1, y: -1 };
  const keys = new Set();
  let heldDuck = false; // from the on-screen duck button

  function canvasPointFromEvent(evt) {
    const r = canvas.getBoundingClientRect();
    const t = evt.changedTouches && evt.changedTouches[0];
    const clientX = t ? t.clientX : evt.clientX;
    const clientY = t ? t.clientY : evt.clientY;
    const scaleX = WIDTH / r.width;
    const scaleY = HEIGHT / r.height;
    return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
  }

  canvas.addEventListener("mousemove", (e) => {
    const p = canvasPointFromEvent(e);
    mouse.x = p.x;
    mouse.y = p.y;
  });

  function doJump() {
    if (state === STATE_PLAYING && dino.y >= GROUND_REST_Y && !isDucking) {
      velY = -15;
    }
  }

  function handlePrimaryTap(px, py) {
    mouse.x = px;
    mouse.y = py;

    if (state === STATE_MENU) {
      if (pointInRect(px, py, L.menuStart)) {
        startGame();
      } else if (pointInRect(px, py, L.menuSupport)) {
        state = STATE_SUPPORT;
      } else if (pointInRect(px, py, L.menuMute)) {
        muted = !muted;
        applyMute();
      } else {
        // tapping elsewhere in the menu on mobile also starts the game,
        // mirroring the "quick start" keyboard shortcut
        if (IS_MOBILE) {
          startGame();
        }
      }
    } else if (state === STATE_SUPPORT) {
      if (pointInRect(px, py, L.supportCard)) {
        copyCardNumber();
      } else if (pointInRect(px, py, L.supportBack)) {
        state = STATE_MENU;
      }
    } else if (state === STATE_PAUSED) {
      if (pointInRect(px, py, L.pauseResume)) {
        state = STATE_PLAYING;
      } else if (pointInRect(px, py, L.pauseMenu)) {
        stopSound(sounds.main);
        stopSound(sounds.main2);
        state = STATE_MENU;
      }
    } else if (state === STATE_GAMEOVER) {
      if (pointInRect(px, py, L.gameoverRestart)) {
        startGame();
      } else if (pointInRect(px, py, L.gameoverMenu)) {
        stopSound(sounds.main2);
        state = STATE_MENU;
      }
    } else if (state === STATE_MILESTONE) {
      if (pointInRect(px, py, L.milestoneBtn)) {
        dismissMilestone();
      }
    } else if (state === STATE_PLAYING) {
      // tapping the game area jumps (unless the tap landed on the
      // dedicated duck button, handled separately)
      doJump();
    }
  }

  canvas.addEventListener("click", (e) => {
    const p = canvasPointFromEvent(e);
    handlePrimaryTap(p.x, p.y);
  });
  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const p = canvasPointFromEvent(e);
      handlePrimaryTap(p.x, p.y);
      // no hover on touch screens - don't leave a button "highlighted"
      mouse.x = -1;
      mouse.y = -1;
    },
    { passive: false }
  );

  const JUMP_KEYS = new Set(["Space", "ArrowUp", "KeyW"]);
  const GAME_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "KeyW", "KeyS", "Enter"]);

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // no page scroll / button clicks
    if (keys.has(e.code)) return; // ignore auto-repeat for one-shot actions
    keys.add(e.code);

    if (e.code === "KeyF") toggleFullscreen();

    if (e.code === "KeyM") {
      muted = !muted;
      applyMute();
    }

    if (state === STATE_MENU) {
      if (e.code === "Enter" || e.code === "Space") {
        startGame();
      }
    } else if (state === STATE_PLAYING) {
      if (JUMP_KEYS.has(e.code)) doJump();
      if (e.code === "Escape") {
        state = STATE_PAUSED;
      }
    } else if (state === STATE_PAUSED) {
      if (e.code === "Escape") {
        state = STATE_PLAYING;
      }
    } else if (state === STATE_GAMEOVER) {
      if (e.code === "Enter" || e.code === "KeyR") {
        startGame();
      } else if (e.code === "Escape") {
        stopSound(sounds.main2);
        state = STATE_MENU;
      }
    } else if (state === STATE_SUPPORT) {
      if (e.code === "Escape") state = STATE_MENU;
    } else if (state === STATE_MILESTONE) {
      if (e.code === "Enter" || e.code === "Space" || e.code === "Escape") {
        dismissMilestone();
      }
    }
  });
  window.addEventListener("keyup", (e) => {
    keys.delete(e.code);
  });

  // If the window loses focus while a key/button is held, the "release" is
  // never seen and the dino would stay ducked forever. Reset everything.
  function releaseAllInputs() {
    keys.clear();
    heldDuck = false;
  }
  window.addEventListener("blur", releaseAllInputs);

  // Auto-pause when the tab/app goes to the background (call, notification,
  // switching apps) so you don't come back to a dead dino.
  document.addEventListener("visibilitychange", () => {
    releaseAllInputs();
    if (document.hidden) {
      if (state === STATE_PLAYING) state = STATE_PAUSED;
    } else {
      lastTime = 0; // avoid a huge time jump on return
    }
  });

  // block iOS pinch-zoom gestures and long-press menus on the game
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  function isDuckKeyHeld() {
    return keys.has("ArrowDown") || keys.has("KeyS") || heldDuck;
  }

  function copyCardNumber() {
    const digits = CARD_NUMBER.replace(/\s/g, "");
    const done = () => showToast("کپی شد!");
    const fail = () => showToast("خطا در کپی");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(digits).then(done).catch(() => {
        legacyCopy(digits) ? done() : fail();
      });
    } else {
      legacyCopy(digits) ? done() : fail();
    }
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---- fullscreen ----
  const fsBtn = document.getElementById("btn-fullscreen");
  const rootEl = document.documentElement;
  const reqFS = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
  const exitFS = document.exitFullscreen || document.webkitExitFullscreen;
  // iPhone Safari has no fullscreen API at all -> the button stays hidden
  // there (add the site to the Home Screen and it opens fullscreen).
  const FS_SUPPORTED = !!(reqFS && exitFS) && document.fullscreenEnabled !== false;

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function unlockOrientation() {
    try {
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    } catch (e) {}
  }
  async function toggleFullscreen() {
    if (!FS_SUPPORTED) return;
    try {
      if (!isFullscreen()) {
        const pr = reqFS.call(rootEl, { navigationUI: "hide" });
        if (pr && pr.then) await pr;
        // on phones, turn the screen sideways too (works in fullscreen only)
        if (IS_MOBILE && screen.orientation && screen.orientation.lock) {
          try {
            await screen.orientation.lock("landscape");
          } catch (e) {}
        }
      } else {
        unlockOrientation();
        const pr = exitFS.call(document);
        if (pr && pr.then) await pr;
      }
    } catch (e) {}
  }
  function onFullscreenChange() {
    const fs = isFullscreen();
    document.body.classList.toggle("is-fullscreen", fs);
    if (fsBtn) fsBtn.setAttribute("aria-label", fs ? "خروج از تمام صفحه" : "تمام صفحه");
    if (!fs) unlockOrientation(); // e.g. user pressed Esc / back
    fitCanvasToDPR();
  }
  if (fsBtn) {
    if (FS_SUPPORTED) {
      fsBtn.hidden = false;
      // mousedown preventDefault: don't let the button take keyboard focus
      // (otherwise pressing Space later would "click" it again)
      fsBtn.addEventListener("mousedown", (e) => e.preventDefault());
      fsBtn.addEventListener("click", () => {
        fsBtn.blur();
        toggleFullscreen();
      });
      document.addEventListener("fullscreenchange", onFullscreenChange);
      document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    } else {
      fsBtn.hidden = true;
    }
  }

  // ---- on-screen touch controls (jump / duck buttons) ----
  const btnJump = document.getElementById("btn-jump");
  const btnDuck = document.getElementById("btn-duck");

  function bindHold(el, onStart, onEnd) {
    const start = (e) => {
      e.preventDefault();
      onStart();
    };
    const end = (e) => {
      e.preventDefault();
      onEnd();
    };
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end, { passive: false });
    el.addEventListener("mousedown", start);
    window.addEventListener("mouseup", end);
  }
  bindHold(
    btnJump,
    () => doJump(),
    () => {}
  );
  bindHold(
    btnDuck,
    () => {
      heldDuck = true;
    },
    () => {
      heldDuck = false;
    }
  );

  let controlsShown = null;
  function updateTouchControlsVisibility() {
    const show = IS_MOBILE && state === STATE_PLAYING;
    if (show !== controlsShown) {
      controlsShown = show;
      document.body.classList.toggle("show-controls", show);
      if (!show) heldDuck = false; // a hidden button can't send "release"
    }
  }

  // ---------------------------------------------------------------------
  // Update loop (fixed 60Hz simulation step, decoupled from paint rate)
  // ---------------------------------------------------------------------
  function update() {
    menuTime += 1;
    if (toastTimer > 0) toastTimer -= 1;

    // site locked from the admin panel (maintenance / ban): freeze the run
    if (window.KG && window.KG.locked && state === STATE_PLAYING) state = STATE_PAUSED;

    if (state !== STATE_PLAYING) return;

    isDucking = isDuckKeyHeld() && dino.y >= GROUND_REST_Y;

    velY += 1;
    dino.y += velY;
    if (dino.y >= GROUND_REST_Y) {
      dino.y = GROUND_REST_Y;
      velY = 0;
    }

    const spd = currentSpeed();
    for (const o of obstacles) o.x -= spd;
    for (const c of coins) c.x -= spd;

    let milestoneTriggered = null;
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      if (o.x + o.w < -2) {
        obstacles.splice(i, 1);
        score += 1;
        if (score === 20 && !milestonesHit.has(20)) {
          milestonesHit.add(20);
          milestoneTriggered = "silver";
        }
        if (score === 50 && !milestonesHit.has(50)) {
          milestonesHit.add(50);
          milestoneTriggered = "gold";
        }
      }
    }
    if (milestoneTriggered) {
      obstacles.length = 0;
      obstacles.push({ x: 1100.0, y: 310, w: 25, h: 40, type: "ground" });
    }

    for (let i = coins.length - 1; i >= 0; i--) {
      if (coins[i].x < -30) coins.splice(i, 1);
    }

    if (obstacles.length === 0) {
      const number = randInt(1, 3);
      const startX = randInt(1100, 1300);
      for (let i = 0; i < number; i++) {
        if (score >= 10 && Math.random() < 0.3) {
          obstacles.push({ x: startX + i * 255, y: 280, w: 40, h: 30, type: "fly" });
        } else {
          obstacles.push({ x: startX + i * 255, y: 310, w: 25, h: 40, type: "ground" });
        }
      }
    }

    if (coins.length === 0 && Math.random() < 0.006) {
      coins.push({ x: 1150.0, y: 235 });
    }

    const hitbox = dinoHitbox();
    let coinHit = null;
    for (const c of coins) {
      const coinRect = { x: c.x - 10, y: c.y - 10, w: 20, h: 20 };
      if (rectsCollide(hitbox, coinRect)) {
        coinHit = c;
        break;
      }
    }
    if (coinHit) {
      coins.splice(coins.indexOf(coinHit), 1);
      shieldCharges = Math.min(shieldCharges + 1, 2);
      spawnParticles(coinHit.x, coinHit.y, [255, 210, 60]);
      playFresh(sounds.coin);
    }

    let died = false;
    for (const o of obstacles) {
      const obsRect = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (rectsCollide(hitbox, obsRect)) {
        if (shieldCharges > 0) {
          shieldCharges -= 1;
          obstacles.splice(obstacles.indexOf(o), 1);
          spawnParticles(hitbox.x, hitbox.y, [80, 170, 255]);
          playFresh(sounds.shield);
        } else {
          died = true;
        }
        break;
      }
    }

    updateParticles();

    if (died) {
      stopSound(sounds.main);
      stopSound(sounds.main2);
      playFresh(sounds.lose);
      flashTimer = 12;
      if (score > highscore) {
        highscore = score;
        saveHighscore(highscore);
      }
      state = STATE_GAMEOVER;
      kgEvent("gameover", { score, best: highscore });
    } else if (milestoneTriggered) {
      triggerMilestone(milestoneTriggered);
    }

    if (flashTimer > 0) flashTimer -= 1;
  }

  // ---------------------------------------------------------------------
  // Main loop — fixed-timestep update (60Hz) decoupled from rendering
  // ---------------------------------------------------------------------
  if (window.KG) window.KG.getState = () => ({ state, score });

  const STEP_MS = 1000 / 60;
  let lastTime = 0;
  let acc = 0;
  function loop(ts) {
    if (!lastTime) lastTime = ts;
    let delta = ts - lastTime;
    lastTime = ts;
    if (delta > 250) delta = 250; // clamp huge gaps (tab backgrounded)
    acc += delta;

    let steps = 0;
    while (acc >= STEP_MS && steps < 5) {
      update();
      acc -= STEP_MS;
      steps++;
    }
    if (steps === 5) acc = 0; // too slow to catch up - don't fast-forward

    // try/finally: one drawing error must never freeze the whole game
    try {
      render(ts);
      updateTouchControlsVisibility();
    } catch (err) {
      console.error(err);
    } finally {
      requestAnimationFrame(loop);
    }
  }

  // ---------------------------------------------------------------------
  // Boot: wait for a user gesture before starting audio (autoplay policy)
  // ---------------------------------------------------------------------
  const overlay = document.getElementById("start-overlay");
  function boot() {
    booted = true;
    overlay.classList.add("hidden");
    unlockAudio();
    playFresh(sounds.main);
    requestAnimationFrame(loop);
  }

  // make sure the canvas fonts are downloaded (canvas text doesn't always
  // trigger the download by itself)
  if (document.fonts && document.fonts.load) {
    ["400 16px Vazirmatn", "500 22px Vazirmatn", "700 26px Vazirmatn", "800 54px Vazirmatn"].forEach((f) =>
      document.fonts.load(f, "بازی کیان پوری").catch(() => {})
    );
  }
  overlay.addEventListener(
    "click",
    () => {
      boot();
    },
    { once: true }
  );
  overlay.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      boot();
    },
    { once: true, passive: false }
  );

  // Render one static frame behind the overlay immediately so it's not blank.
  render(0);
})();
