'use strict';
/* 言って。 — 节奏 FPS demo v0.2
   v0.2：世界改成"有墙有地的房间"，靶子只在房间里的靶区内出现 → 有明确的定位范围。
   鼠标转视角 / 左键开火 / 按住跟枪；她探头举牌时打中牌子额外加分，打中她会不高兴。 */

let CHART = null;
const RAD = Math.PI / 180;
const cvs = document.getElementById('c');
const ctx = cvs.getContext('2d');
const audio = new Audio();
audio.preload = 'auto';

let W = 0, H = 0, DPR = 1;
const BUILD = '2026-10-20.6';
console.log('[节奏FPS] build', BUILD);
const FOVH = 100;

/* ---------- 房间（单位：米） ---------- */
const ROOM = { w: 20, h: 7, d: 18 };          // x ∈ [-10,10]，y ∈ [0,7]，z ∈ [-18,0]
const cam = { x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0 };
const VIEW_YAW = 72, VIEW_PITCH = 30;         // 视角限位：不会转到墙后面去

let BEAT = 60 / 92;

/* ---------- 灵敏度：跟《无畏契约》同一口径 ----------
   瓦的 yaw = 0.07 度 / 鼠标计数 / 灵敏度单位（CS 是 0.022，所以换算系数 3.18）
   于是「同样的手」= 每单位移动转同样角度：degPerUnit = 0.07 * sensVal
   浏览器 pointer lock（unadjustedMovement）给的 movementX 基本就是计数。 */
const VALO_YAW = 0.07;
const SENS_KEY = 'sf_valo_sens', DPI_KEY = 'sf_dpi';
const loadNum = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) && v > 0 ? v : d; };
const VALO = { sens: loadNum(SENS_KEY, 0.4), dpi: loadNum(DPI_KEY, 800) };
function degPerUnit() { return VALO_YAW * VALO.sens; }
function cmPer360() { return 2.54 * 360 / (VALO_YAW * VALO.sens * VALO.dpi); }
function applySens() {
  S.sens = degPerUnit();
  localStorage.setItem(SENS_KEY, VALO.sens);
  localStorage.setItem(DPI_KEY, VALO.dpi);
}

let MV_OFFSET = parseFloat(localStorage.getItem('songfps_mvoff') || '0') || 0;   // MV 相对音频的偏移（秒）

/* 立绘：有差分就换，没有就退回 her.png */
const SPRITES = {
  base: 'her.png',
  xeye: 'her_xeye.png',
  pout: 'her_pout.png',
  smile: 'her_smile.png',
  surprise: 'her_surprise.png'
};
const imgs = {};
for (const [k, src] of Object.entries(SPRITES)) {
  const im = new Image();
  im.src = src;
  im.onerror = () => { im.failed = true; };
  imgs[k] = im;
}
function spriteFor(kind) {
  const im = imgs[kind];
  return (im && im.complete && !im.failed && im.naturalWidth) ? im : imgs.base;
}

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = cvs.clientWidth; H = cvs.clientHeight;
  cvs.width = Math.round(W * DPR); cvs.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);

/* ---------- 投影 ---------- */
function basis() {
  const wob = S.mio && S.mio.phase === 'attach';
  const y = (cam.yaw + (wob ? Math.sin(performance.now() / 95) * 1.8 : 0)) * RAD;
  const p = (cam.pitch + (wob ? Math.cos(performance.now() / 135) * 1.2 : 0)) * RAD;
  const f = [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
  const r = [Math.cos(y), 0, Math.sin(y)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}
function project3(x, y, z, B) {
  const v = [x - cam.x, y - cam.y, z - cam.z];
  const zc = v[0] * B.f[0] + v[1] * B.f[1] + v[2] * B.f[2];
  if (zc < 0.2) return null;
  const xc = v[0] * B.r[0] + v[1] * B.r[1] + v[2] * B.r[2];
  const yc = v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2];
  const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
  return { x: W / 2 + (xc / zc) * k, y: H / 2 - (yc / zc) * k, z: zc };
}
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

/* ---------- 音效 ---------- */
let AC = null;
let GRAPH = null;

/* 混响：指数衰减噪声当脉冲响应，够用且不用外部文件 */
function makeImpulse(a, seconds) {
  const len = Math.floor(a.sampleRate * seconds);
  const buf = a.createBuffer(2, len, a.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  return buf;
}

function ac() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    const master = AC.createGain();
    const limiter = AC.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 10;
    limiter.ratio.value = 5; limiter.attack.value = 0.003; limiter.release.value = 0.22;
    master.connect(limiter).connect(AC.destination);

    const conv = AC.createConvolver();
    conv.buffer = makeImpulse(AC, 0.75);
    const wet = AC.createGain();
    wet.gain.value = 0.16;
    conv.connect(wet).connect(master);

    GRAPH = { master, limiter, wet };

    if (AC.state === 'suspended') AC.resume().catch(() => { });
  }
  return AC;
}

/* 把声音放到世界里某个位置；不给位置就居中、不走 HRTF */
function tone(freq, dur, type = 'sine', gain = 0.05, slideTo = null, world = null) {
  try {
    const a = ac();
    if (a.state === 'suspended') a.resume();
    if (!MUSIC_SRC) attachMusic();
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g);
    if (world && world.x !== undefined) {
      const pn = a.createPanner();
      pn.panningModel = 'HRTF';
      pn.distanceModel = 'inverse';
      pn.refDistance = 3.5; pn.maxDistance = 40; pn.rolloffFactor = 0.85;
      pn.positionX.value = world.x; pn.positionY.value = world.y; pn.positionZ.value = world.z;
      g.connect(pn); pn.connect(GRAPH.master);
      const send = a.createGain(); send.gain.value = 0.4;
      g.connect(send); send.connect(GRAPH.wet);
    } else {
      g.connect(GRAPH.master);
    }
    o.start(); o.stop(a.currentTime + dur + 0.02);
  } catch (e) { }
}

let MUSIC_SRC = null;
function attachMusic() { /* 音乐不经过 WebAudio，只走 <audio> 元素输出 */ }

function updateListener() {
  if (!AC) return;
  const L = AC.listener;
  const y = cam.yaw * RAD, pt = cam.pitch * RAD;
  const fx = Math.sin(y) * Math.cos(pt), fy = Math.sin(pt), fz = -Math.cos(y) * Math.cos(pt);
  if (L.positionX) {
    L.positionX.value = cam.x; L.positionY.value = cam.y; L.positionZ.value = cam.z;
    L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
    L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
  } else if (L.setPosition) {
    L.setPosition(cam.x, cam.y, cam.z);
    L.setOrientation(fx, fy, fz, 0, 1, 0);
  }
}

/* 每首歌的响度补偿（dB），由 loudnorm 实测：itte -7.4 LUFS / haru -9.0 LUFS */
function applySongGain(song) {
  const gdb = (song && typeof song.gain === 'number') ? song.gain : 0;
  const lin = gdb ? Math.pow(10, gdb / 20) : 1;
  try { audio.volume = Math.max(0.05, Math.min(1, lin)); } catch (e) { }
}

const sfx = {
  hit(perfect, world) { tone(perfect ? 1320 : 990, 0.07, 'triangle', 0.05, null, world); },
  miss() { tone(180, 0.09, 'sine', 0.035, 120); },
  board(world) { tone(880, 0.09, 'sine', 0.06, null, world); setTimeout(() => tone(1320, 0.12, 'sine', 0.05, null, world), 70); },
  her(world) { tone(420, 0.18, 'sawtooth', 0.045, 160, world); },
  show(world) { tone(660, 0.08, 'sine', 0.04, null, world); }
};


/* ---------- 主菜单（曲目盘） ---------- */
const DIFF_NAMES = ['简单', '普通', '困难'];
const MENU = { idx: 0, diff: 1, angle: 0, covers: [], songs: window.SONGS || [] };
for (const sng of MENU.songs) {
  const im = new Image();
  im.src = sng.cover;
  MENU.covers.push(im);
}

/* ---------- 状态 ---------- */
const S = {
  running: false, paused: true, t: 0,
  score: 0, combo: 0, maxCombo: 0, hits: 0, misses: 0, perfects: 0,
  targets: [], her: null, sparks: [], popups: [],
  evPtr: 0, herPtr: 0, beatPtr: 0,
  holding: null,
  sens: 0.07 * (parseFloat(localStorage.getItem('sf_valo_sens')) > 0 ? parseFloat(localStorage.getItem('sf_valo_sens')) : 0.4),
  shake: 0, flash: 0, beatFlash: 0, muzzle: 0,
  herBoard: 0, herHit: 0, herPoutUntil: -1,
  msgUntil: 0, clock: 0, screenMode: 0, diffLevel: 2, lifeMul: 1,
  threats: [], claudeT: 0, blackout: 0, sheetStuck: 0, nextThreat: 18, threatCount: 0,
  mio: null, nextMio: 32
};

/* ---------- DOM ---------- */
const $score = document.getElementById('score');
const $sub = document.getElementById('sub');
const $combo = document.getElementById('combo');
const $time = document.getElementById('time');
const $acc = document.getElementById('acc');
const $msg = document.getElementById('msg');
const $start = document.getElementById('start');
const $pause = document.getElementById('pause');
const $end = document.getElementById('end');

function showMsg(text, ms = 1400) {
  $msg.textContent = text;
  $msg.style.opacity = '1';
  S.msgUntil = performance.now() + ms;
}
const comboMult = () => 1 + Math.min(S.combo, 40) / 40;

/* ---------- 调试开关 ---------- */
const PARAMS = new URLSearchParams(location.search);
if (PARAMS.has('song')) {
  const q = parseInt(PARAMS.get('song'), 10);
  if (q >= 0 && q < MENU.songs.length) MENU.idx = q;
}
if (PARAMS.has('diff')) {
  const q2 = parseInt(PARAMS.get('diff'), 10);
  if (q2 >= 0 && q2 <= 2) MENU.diff = q2;
}
const DEBUG = PARAMS.has('debug');
const AUTO = PARAMS.get('auto') || '';
S.clock = parseFloat(PARAMS.get('at') || '0') || 0;
const nowT = () => (DEBUG ? S.clock : audio.currentTime);

/* ---------- 开局 ---------- */
function resetGame() {
  S.score = 0; S.combo = 0; S.maxCombo = 0; S.hits = 0; S.misses = 0; S.perfects = 0;
  S.targets = []; S.her = null; S.sparks = []; S.popups = []; S.evPtr = 0;
  S.threats = []; S.claudeT = 0; S.blackout = 0; S.sheetStuck = 0; S.nextThreat = 18; S.threatCount = 0;
  S.mio = null; S.nextMio = 32; S.herPtr = 0; S.beatPtr = 0;
  S.holding = null; S.shake = 0; S.flash = 0; S.muzzle = 0;
  S.herBoard = 0; S.herHit = 0; S.herPoutUntil = -1;
  cam.yaw = 0; cam.pitch = 0;
}
function currentSong() { return MENU.songs[MENU.idx]; }

function startGame() {
  const song = currentSong();
  if (!song) return;
  CHART = (window.CHARTS || {})[song.id] || null;
  if (!CHART) { showMsg('谱面没加载到：' + song.id); return; }
  BEAT = 60 / (CHART.bpm || 92);
  S.diffLevel = MENU.diff + 1;                        // 1 简单 / 2 普通 / 3 困难
  S.lifeMul = MENU.diff === 0 ? 1.3 : (MENU.diff === 2 ? 0.8 : 1);
  resetGame();
  ac();
  loadVideoFor(song);
  attachMusic();
  if (!DEBUG) {
    clearTimeout(PREVIEW.timer);
    audio.pause();
    audio.src = song.audio;
    audio.load();
    audio.currentTime = 0;
    audio.play().catch(() => { });
  } else {
    while (S.evPtr < CHART.events.length && CHART.events[S.evPtr].t < S.clock - 0.5) S.evPtr++;
    while (S.herPtr < CHART.her.length && CHART.her[S.herPtr].t < S.clock - 0.6) S.herPtr++;
    while (S.beatPtr < CHART.beats.length && CHART.beats[S.beatPtr] < S.clock) S.beatPtr++;
    for (let i = 0; i < 60; i++) update(1 / 30);
    // &pose=smile|xeye|pout|surprise|base —— 只用于截图自测
    const sc0 = PARAMS.get('screen'); if (sc0) S.screenMode = parseInt(sc0, 10) || 0;
    const pose = PARAMS.get('pose');
    if (pose) {
      spawnHer({ side: 'R' });
      const hh = S.her;
      hh.surpriseT = 0;
      if (pose === 'smile') hh.smileT = 99;
      if (pose === 'surprise') hh.surpriseT = 99;
      if (pose === 'xeye') { hh.body = true; hh.xeye = 99; }
      if (pose === 'pout') { hh.body = true; }
      for (let i = 0; i < 45; i++) update(1 / 30);   // 让她滑到位
    }

    const _mio = PARAMS.get('mio');
    if (_mio) { mioSpawn(); if (_mio === 'attach') { S.mio.phase = 'attach'; S.mio.t0 = S.t; } S.nextMio = 99999; }
    const _cl = PARAMS.get('claude');
    if (_cl) S.claudeT = 999;
    const _th = PARAMS.get('threat');
    if (_th === 'book' || _th === 'sheet') {
      spawnThreat(_th);
      for (const g of S.threats) { g.vx *= 0.28; g.vy *= 0.28; g.vz *= 0.28; }
      S.nextThreat = 99999;
    }
    // &selftest=1：模拟跑几秒，把关键状态写进 document.title，供 --dump-dom 检查
    if (PARAMS.has('selftest')) {
      const samples = [];
      let flickSeen = false;
      for (let i = 0; i < 240; i++) {
        update(1 / 30);
        const hs = S.targets.filter(g => g.type === 'hold' && !g.hit);
        if (hs.length) samples.push([+S.t.toFixed(2), +hs[0].x.toFixed(2), +hs[0].y.toFixed(2)]);
        if (S.targets.some(g => g.type === 'hold' && !g.hit) &&
            S.targets.some(g => g.type === 'flick' && S.t - g.born < 0.1)) flickSeen = true;
      }
      document.title = 'SELFTEST ' + JSON.stringify({
        holdSamples: samples.slice(0, 8),
        holdMoved: samples.length > 1 &&
          (Math.abs(samples[samples.length - 1][1] - samples[0][1]) > 0.2 ||
           Math.abs(samples[samples.length - 1][2] - samples[0][2]) > 0.2),
        flickDuringHold: flickSeen,
        hits: S.hits, misses: S.misses, combo: S.combo
      });
    }
  }
  S.running = true; S.paused = false;
  applySongGain(song);
  if ($start) $start.style.display = 'none';
  if ($end) $end.style.display = 'none';
  if ($pause) $pause.style.display = 'none';
  lockPointer();
  setTimeout(() => {
    if (S.running && !DEBUG && !document.pointerLockElement) showMsg('鼠标没锁住？按 F11 全屏后再点一下', 4000);
  }, 1500);
}
function lockPointer() {
  if (DEBUG) return;
  try {
    const p = cvs.requestPointerLock({ unadjustedMovement: true });   // 关掉系统鼠标加速（不然快甩会突然飞出去）
    if (p && p.catch) p.catch(() => { try { cvs.requestPointerLock(); } catch (e) { } });
  } catch (e) { try { cvs.requestPointerLock(); } catch (e2) { } }
}

function finish() {
  S.running = false; S.paused = true;
  if (SCREEN.video) SCREEN.video.pause();
  document.exitPointerLock && document.exitPointerLock();
  const total = S.hits + S.misses;
  const acc = total ? Math.round(S.hits / total * 100) : 0;
  document.getElementById('endScore').textContent = `得分 ${S.score}　最高连击 ${S.maxCombo}`;
  document.getElementById('endAcc').textContent = `命中 ${S.hits} / ${total}　准确率 ${acc}%`;
  document.getElementById('endHer').textContent = S.herHit > 0
    ? `打了她 ${S.herHit} 次…（牌子 ${S.herBoard} 次）`
    : `牌子打中 ${S.herBoard} 次`;
  $end.style.display = 'flex';
}
document.getElementById('again').addEventListener('click', () => { document.getElementById('end').style.display = 'none'; startGame(); });
/* ---------- ESC 菜单的四个按钮 ---------- */
function resumeGame() {
  const p = document.getElementById('pause');
  if (p) p.style.display = 'none';
  S.paused = false;
  audio.play().catch(() => { });
  lockPointer();
}
function restartSong() {
  const p = document.getElementById('pause');
  if (p) p.style.display = 'none';
  S.paused = false;
  startGame();
}
function backToMenu() {
  const p = document.getElementById('pause'), e2 = document.getElementById('end');
  if (p) p.style.display = 'none';
  if (e2) e2.style.display = 'none';
  S.paused = false; S.running = false;
  if (SCREEN.video) SCREEN.video.pause();
  try { audio.pause(); } catch (e) { }
  try { audio.currentTime = 0; } catch (e) { }
  clearTimeout(PREVIEW.timer);
  document.exitPointerLock && document.exitPointerLock();
  resetGame();
  S.mio = null; S.threats = [];
  cam.yaw = 0; cam.pitch = 0;
}
function quitGame() {
  try { window.close(); } catch (e) { }
  setTimeout(() => {
    if (!window.closed) showMsg('浏览器不让脚本关窗口——按 Alt+F4 退出', 4000);
  }, 300);
}

(function bindPauseMenu() {
  const r = document.getElementById('resume');
  const rs = document.getElementById('restart');
  const os = document.getElementById('open-sens');
  const tm = document.getElementById('to-menu');
  const qt = document.getElementById('quit');
  r && r.addEventListener('click', resumeGame);
  rs && rs.addEventListener('click', restartSong);
  os && os.addEventListener('click', () => { openSensPanel(); });
  tm && tm.addEventListener('click', backToMenu);
  qt && qt.addEventListener('click', quitGame);
})();
document.addEventListener('pointerlockchange', () => {
  if (DEBUG) return;
  if (S.running && document.pointerLockElement !== cvs) {
    S.paused = true; audio.pause();
    $pause.style.display = 'flex';
  }
});

/* ---------- 输入 ---------- */
document.addEventListener('mousemove', e => {
  if (!S.running || S.paused) return;
  const dx = e.movementX, dy = e.movementY;
  if (Math.abs(dx) > 500 || Math.abs(dy) > 500) return;   // 尖峰：不是玩家的手，是系统抖出来的
  cam.yaw = clamp(cam.yaw + dx * S.sens, -VIEW_YAW, VIEW_YAW);
  cam.pitch = clamp(cam.pitch - dy * S.sens, -VIEW_PITCH, VIEW_PITCH);
});
document.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  if (!S.running) {
    if (e.key === 's' || e.key === 'S') { openSensPanel(); return; }
    const n = MENU.songs.length || 1;
    const rr = Math.min(H * 0.30, W * 0.19), cxm = W * 0.68;
    if (e.clientX < cxm - rr) { switchSong(-1); return; }
    if (e.clientX > cxm + rr) { switchSong(1); return; }
    startGame(); return;
  }
  if (S.paused) return;
  tryHoldOrFire();
});
document.addEventListener('mouseup', e => { if (e.button === 0) releaseHold(); });
window.addEventListener('keydown', e => {
  if (e.key === '0') {
    try {
      const a = ac();
      if (a.state === 'suspended') a.resume();
      tone(660, 0.25, 'sine', 0.25);
      setTimeout(() => tone(880, 0.35, 'sine', 0.22), 260);
      showMsg('测试音 660/880Hz　·　听不见就是浏览器或设备的问题', 2200);
    } catch (err) { showMsg('音频上下文创建失败：' + err.message, 3000); }
    return;
  }
  if (e.key === 'Escape' && S.running && S.paused) { resumeGame(); return; }
  if (!S.running) {
    if (e.key === 's' || e.key === 'S') { openSensPanel(); return; }
    const n = MENU.songs.length || 1;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { switchSong(-1); return; }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { switchSong(1); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { MENU.diff = (MENU.diff + (e.key === 'ArrowUp' ? 2 : 1)) % 3; MENU.boost = 0.8; MENU.mood = 0.6; return; }
    if (e.key === '1' || e.key === '2' || e.key === '3') { MENU.diff = parseInt(e.key, 10) - 1; return; }
    if (e.key === 'Enter' || e.key === ' ') { startGame(); return; }
  }
  if (e.key === '[') { VALO.sens = Math.max(0.02, +(VALO.sens * 0.9).toFixed(3)); applySens(); showMsg('灵敏度 ' + VALO.sens + ' ≈ ' + cmPer360().toFixed(1) + ' cm/360'); }
  if (e.key === ']') { VALO.sens = Math.min(3, +(VALO.sens * 1.1).toFixed(3)); applySens(); showMsg('灵敏度 ' + VALO.sens + ' ≈ ' + cmPer360().toFixed(1) + ' cm/360'); }
  if (e.key === ',' || e.key === '.') {          // MV 相对音乐的前后微调
    MV_OFFSET = Math.round((MV_OFFSET + (e.key === ',' ? -0.1 : 0.1)) * 10) / 10;
    localStorage.setItem('songfps_mvoff', MV_OFFSET);
    if (SCREEN.video) SCREEN.video.currentTime = Math.max(0, nowT() + MV_OFFSET);
    showMsg('MV 偏移 ' + MV_OFFSET.toFixed(1) + 's', 1200);
  }
  if (e.key === 'm' || e.key === 'M') {
    S.screenMode = (S.screenMode + 1) % 3;
    if (S.screenMode === 2) ensureVideo();
    if (S.screenMode === 2 && SCREEN.video) { SCREEN.video.currentTime = Math.max(0, nowT() + MV_OFFSET + ((currentSong() && currentSong().mvOffset) || 0)); SCREEN.video.play().catch(() => { }); }
    if (S.screenMode !== 2 && SCREEN.video) SCREEN.video.pause();
    showMsg(['后屏：靶区格子', '后屏：专辑封面', '后屏：MV'][S.screenMode], 1200);
  }
});

/* ---------- 她 ---------- */
function spawnHer(ev) {
  if (S.t < S.herPoutUntil) return;
  const side = ev.side === 'L' ? -1 : 1;
  S.her = {
    side, t0: S.t,
    xA: side * 7.2, xB: side * 2.7,
    z: -3.1,
    x: side * 2.7,
    state: 'probe', board: false, body: false, xeye: 0, pout: 0, surpriseT: 0.45, smileT: 0
  };
  sfx.show();
  showMsg('……！', 700);
}
function herAnchor() {
  const h = S.her; if (!h) return null;
  const k = clamp((S.t - h.t0) / 0.55, 0, 1);
  const e = 1 - Math.pow(1 - k, 3);
  h.x = h.xA + (h.xB - h.xA) * e;
  return h;
}
/* 立绘：整张图 2.05m 高（脚底在 y=0）; 牌子是画在立绘里的 —— 由 make_sprites2.py 量出来:
   board_up = 0.857 （牌子中心离地占整图高度的比例）; board_r = 0.137 */
const HER_H = 2.25;
const BOARD_Y = 0.857 * HER_H, BOARD_R = 0.137 * HER_H;


/** 把方向折回视角限位之内（超界时镜像，而不是硬夹） */
function reachYaw(y) {
  const lim = VIEW_YAW - 6;
  if (y > lim) y = Math.max(-lim, 2 * lim - y);
  else if (y < -lim) y = Math.min(lim, -2 * lim - y);
  return Math.max(-lim, Math.min(lim, y));
}
function reachPitch(p) {
  const lim = VIEW_PITCH - 5;
  if (p > lim) p = Math.max(-lim, 2 * lim - p);
  else if (p < -lim) p = Math.min(lim, -2 * lim - p);
  return Math.max(-lim, Math.min(lim, p));
}

/* ---------- 目标 ---------- */
function spawnTarget(ev) {
  const fast = !!ev.fast;
  const d = 9 + Math.random() * 6;                        // 深度 9–15 米
  const yawOff = (Math.random() < 0.5 ? -1 : 1) * (fast ? 10 + Math.random() * 16 : 12 + Math.random() * 26);
  const pitchOff = (-0.55 + Math.random() * 0.75) * 22;
  // 关键：目标必须落在视角限位之内，否则玩家会撞上"空气墙"
  const yawWant = reachYaw(cam.yaw + yawOff);
  const pitchWant = reachPitch(cam.pitch + pitchOff);
  const ang = yawWant * RAD;
  const x = clamp(Math.tan(ang) * d, -8.5, 8.5);
  const y = clamp(cam.y + Math.tan(pitchWant * RAD) * d, 0.9, 6.2);
  const z = -d;
  const t = {
    x, y, z,
    rw: Math.hypot(x - cam.x, y - cam.y, z - cam.z) * Math.tan(2.6 * RAD),
    type: ev.type === 'hold' ? 'hold' : 'flick',
    fast,
    born: S.t,
    life: ev.type === 'hold' ? ev.dur : (fast ? BEAT * 1.05 : BEAT * 1.9) * S.lifeMul,
    dur: ev.dur || 0,
    progress: 0, hit: false, grabbed: false,
    // 黄球不是死的：绕着出生点跑八字
    bx: x, by: y, ax: 1.1 + Math.random() * 1.1, ay: 0.5 + Math.random() * 0.5,
    phase: Math.random() * Math.PI * 2, ampW: (Math.PI * 2) / (BEAT * 3)
  };
  for (const g of S.targets) {          // 别挤成一坨
    if (Math.hypot(g.x - t.x, g.y - t.y, g.z - t.z) < 1.6) t.x += (t.x < 0 ? -1 : 1) * 1.4;
  }
  S.targets.push(t);
}



/* ---------- 澪：探头 → 敲头 → 贴脸干扰 ---------- */
const MIO_IMG = new Image();
MIO_IMG.src = 'mio_peek.png';

function mioSpawn() {
  if (S.mio) return;
  const side = Math.random() < 0.5 ? -1 : 1;
  S.mio = {
    phase: 'peek',
    t0: S.t,
    side,
    yaw: reachYaw(cam.yaw + side * (34 + Math.random() * 8)),   // 世界方向：得转过去才看得见她
    pitch: 3 + Math.random() * 3,
    wob: Math.random() * 6.28
  };
  showMsg('澪来看你了——敲她的头', 1200);
  sfx.show();
}

function mioWorldPos() {
  const m = S.mio;
  if (!m) return null;
  const attach = m.phase === 'attach';
  const dist = attach ? 2.9 : 4.6;
  const yaw = attach ? cam.yaw + Math.sin(S.t * 2.2 + m.wob) * 7 : m.yaw;
  const pitch = attach ? -2 + Math.cos(S.t * 1.7 + m.wob) * 2.5 : m.pitch;
  return {
    x: cam.x + Math.sin(yaw * RAD) * dist,
    y: cam.y + Math.tan(pitch * RAD) * dist,
    z: cam.z - Math.cos(yaw * RAD) * dist,
    dist,
    attach
  };
}

function mioHitCheck() {
  if (!S.mio) return false;
  const p = mioWorldPos();
  if (!p) return false;
  const rDeg = p.attach ? 4.5 : 6.0;
  if (aimAngleTo(p.x, p.y, p.z) > rDeg) return false;
  const attached = S.mio.phase === 'attach';
  const B = basis();
  const sp = project3(p.x, p.y, p.z, B);
  S.mio = null;
  S.score += attached ? 150 : 250;
  S.combo++;
  S.hits++;
  sfx.board({ x: p.x, y: p.y, z: p.z });
  showMsg(attached ? '甩掉了！' : '敲到了，她跑了', 1000);
  if (sp) S.sparks.push({ x: sp.x, y: sp.y, t: 0, r: 50 });
  return true;
}

function mioUpdate(dt) {
  if (!S.mio) return;
  const m = S.mio;
  const age = S.t - m.t0;
  if (m.phase === 'peek' && age > 3.0) {
    m.phase = 'attach';
    m.t0 = S.t;
    showMsg('她贴上来了！打她的头甩开', 1400);
    sfx.her();
  } else if (m.phase === 'attach' && age > 5.0) {
    S.mio = null;
  }
}

function drawMio() {
  if (!S.mio) return;
  const p = mioWorldPos();
  if (!p) return;
  const B = basis();
  const sp = project3(p.x, p.y, p.z, B);
  if (!sp) return;
  const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
  const hh = (2.35 / p.dist) * k;         // 这张是接近全身的立绘
  const ww = hh * (1024 / 1536);
  const sx = sp.x - ww * 0.50;
  const sy = sp.y - hh * 0.14;
  ctx.save();
  ctx.drawImage(MIO_IMG, sx, sy, ww, hh);
  ctx.restore();
  const hx = sp.x, hy = sp.y + hh * 0.03;           // sp 是她的头附近
  const rPx = hh * 0.15;
  const left = S.mio.phase === 'peek' ? Math.max(0, 1 - (S.t - S.mio.t0) / 3.0) : 1;
  ctx.save();
  ctx.beginPath();
  if (S.mio.phase === 'peek') {
    ctx.arc(hx, hy, rPx, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.strokeStyle = left > 0.35 ? 'rgba(255,220,120,0.9)' : 'rgba(255,110,110,0.95)';
  } else {
    ctx.arc(hx, hy, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,110,110,0.9)';
    ctx.setLineDash([10, 8]);
  }
  ctx.lineWidth = 5; ctx.stroke();
  ctx.restore();
}

/* ---------- 场外干扰：Claude 扔书 / 澪 甩设计稿 ---------- */
const CLAUDE_IMG = new Image();
CLAUDE_IMG.src = 'claude_peek.png';

function spawnThreat(kind) {
  const side = Math.random() < 0.5 ? -1 : 1;
  const speed = kind === 'book' ? 7.2 : 5.4;
  const t = {
    kind,
    x: side * (3.0 + Math.random() * 1.6),
    y: 2.0 + Math.random() * 0.9,
    z: -7.5,
    r: kind === 'book' ? 0.34 : 0.62,
    spin: (Math.random() - 0.5) * 6,
    ang: 0,
    born: S.t,
    hit: false
  };
  // 朝镜头方向飞（大致对准摄像机上方的准星）
  const dx = cam.x - t.x, dy = cam.y + 0.1 - t.y, dz = cam.z - t.z;
  const L = Math.hypot(dx, dy, dz) || 1;
  t.vx = dx / L * speed; t.vy = dy / L * speed; t.vz = dz / L * speed;
  S.threats.push(t);
  if (kind === 'book') { S.claudeT = 1.2; showMsg('Claude 扔书了！', 1100); }
  else { showMsg('澪把设计稿甩过来了！', 1100); }
  sfx.show();
}

function updateThreats(dt) {
  if (S.t > (S.nextThreat || 18)) {
    const kind = 'book';
    spawnThreat(kind);
    S.threatCount = (S.threatCount || 0) + 1;
    S.nextThreat = S.t + 17 + Math.random() * 13;
  }
  for (const g of S.threats) {
    if (g.hit) continue;
    g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
    g.ang += g.spin * dt;
    if (g.z > -0.9) {
      g.hit = true;
      g.done = true;
      S.combo = 0; S.misses++;
      S.shake = 1;
      if (g.kind === 'book') { S.blackout = 0.8; sfx.her(); }
      else { S.sheetStuck = 2.6; sfx.her(); }
    }
  }
  S.threats = S.threats.filter(g => !g.done);
  if (S.claudeT > 0) S.claudeT = Math.max(0, S.claudeT - dt);
  if (S.blackout > 0) S.blackout = Math.max(0, S.blackout - dt);
  if (S.sheetStuck > 0) S.sheetStuck = Math.max(0, S.sheetStuck - dt);
}

function hitThreat() {
  const B = basis();
  let best = null, bd = 1e9;
  for (const g of S.threats) {
    if (g.hit) continue;
    const p = project3(g.x, g.y, g.z, B);
    if (!p) continue;
    const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
    const rPx = (g.r / p.z) * k;
    const d = Math.hypot(W / 2 - p.x, H / 2 - p.y);
    if (d < rPx && d < bd) { bd = d; best = g; }
  }
  return best;
}

function drawThreats(B) {
  const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
  for (const g of S.threats) {
    if (g.hit) continue;
    const p = project3(g.x, g.y, g.z, B);
    if (!p) continue;
    const s = (g.r * 2 / p.z) * k;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (g.kind === 'book') {
      ctx.rotate(g.ang);
      ctx.shadowColor = 'rgba(255,180,120,0.5)'; ctx.shadowBlur = 18;
      ctx.fillStyle = '#e9e2cf'; ctx.fillRect(-s * 0.34, -s * 0.5, s * 0.68, s);      // 书页
      ctx.fillStyle = '#1d2a44'; ctx.fillRect(-s * 0.5, -s * 0.56, s * 0.34, s * 1.12); // 封面
      ctx.strokeStyle = 'rgba(226,190,110,0.85)'; ctx.lineWidth = Math.max(1, s * 0.02);
      ctx.strokeRect(-s * 0.5, -s * 0.56, s * 0.34, s * 1.12);
      ctx.strokeStyle = 'rgba(40,40,50,0.25)';
      for (let i = 1; i < 5; i++) {
        ctx.beginPath(); ctx.moveTo(-s * 0.33 + i * s * 0.13, -s * 0.5);
        ctx.lineTo(-s * 0.33 + i * s * 0.13, s * 0.5); ctx.stroke();
      }
    } else {
      ctx.rotate(g.ang * 0.3);
      ctx.shadowColor = 'rgba(180,220,255,0.45)'; ctx.shadowBlur = 20;
      ctx.fillStyle = 'rgba(244,247,255,0.92)';
      ctx.fillRect(-s * 0.5, -s * 0.62, s, s * 1.24);
      ctx.strokeStyle = 'rgba(120,160,220,0.55)'; ctx.lineWidth = 1;
      for (let i = 1; i < 6; i++) {
        ctx.beginPath(); ctx.moveTo(-s * 0.5, -s * 0.62 + i * s * 0.2);
        ctx.lineTo(s * 0.5, -s * 0.62 + i * s * 0.2); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(70,90,130,0.6)';
      ctx.beginPath(); ctx.moveTo(-s * 0.36, -s * 0.2); ctx.lineTo(s * 0.2, -s * 0.2);
      ctx.lineTo(s * 0.05, -s * 0.05); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.36, s * 0.16); ctx.lineTo(s * 0.32, s * 0.16); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }
}

function drawClaudePeek() {
  if (!(S.claudeT > 0) || !CLAUDE_IMG.complete) return;
  const a = Math.min(1, S.claudeT * 2.2);
  const h = H * 0.72;
  const w = h * (1024 / 1536);
  const x = W - w * 0.56;            // 从右边探进来
  const y = H * 0.02;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.drawImage(CLAUDE_IMG, x, y, w, h);
  ctx.restore();
}

function drawThreatOverlays() {
  // 被书砸到：一下黑屏
  if (S.blackout > 0) {
    const a = Math.min(1, S.blackout / 0.8);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.92 * a) + ')';
    ctx.fillRect(0, 0, W, H);
  }
  // 被设计稿糊住：半透明纸贴在准星上
  if (S.sheetStuck > 0) {
    const a = Math.min(1, S.sheetStuck / 0.8);
    const w = W * 0.52, h = H * 0.62;
    ctx.save();
    ctx.globalAlpha = 0.78 * a;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.03);
    ctx.fillStyle = 'rgba(238,242,252,0.95)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(120,160,220,0.55)'; ctx.lineWidth = 1;
    for (let i = 1; i < 9; i++) {
      ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2 + i * h / 9); ctx.lineTo(w / 2, -h / 2 + i * h / 9); ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(-w / 2 + i * w / 5, -h / 2); ctx.lineTo(-w / 2 + i * w / 5, h / 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(60,80,120,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-w * 0.3, -h * 0.1); ctx.lineTo(w * 0.1, -h * 0.12);
    ctx.lineTo(-w * 0.05, h * 0.05); ctx.stroke();
    ctx.restore();
  }
}

/* ---------- 准星与命中 ---------- */
function aimAngleTo(x, y, z) {
  const B = basis();
  const v = [x - cam.x, y - cam.y, z - cam.z];
  const zc = v[0] * B.f[0] + v[1] * B.f[1] + v[2] * B.f[2];
  if (zc <= 0) return 999;
  const xc = v[0] * B.r[0] + v[1] * B.r[1] + v[2] * B.r[2];
  const yc = v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2];
  return Math.hypot(Math.atan2(xc, zc), Math.atan2(yc, zc)) / RAD;
}
function tryHoldOrFire() {
  if (S.mio && mioHitCheck()) return;
  const th = hitThreat();
  if (th) {
    th.hit = true; th.done = true;
    S.score += 250; S.hits++; S.flash = 0.6;
    sfx.board({ x: th.x, y: th.y, z: th.z });
    const B0 = basis(); const p0 = project3(th.x, th.y, th.z, B0);
    if (p0) S.sparks.push({ x: p0.x, y: p0.y, t: 0, r: 40 });
    return;
  }
  const h = S.her;
  if (h && S.t - h.t0 > 0.25) {
    const B = basis();
    const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
    const bp = project3(h.x, BOARD_Y, h.z, B);
    if (bp) {
      const rPx = (BOARD_R / bp.z) * k;
      const cx = W / 2, cy = H / 2;
      if (!h.board && !h.body && Math.hypot(cx - bp.x, cy - bp.y) < rPx * 1.1) { hitHerBoard(); return; }
      const feet = project3(h.x, 0, h.z, B);
      if (feet) {
        const hp = (HER_H / feet.z) * k, wp = hp * 0.53;
        const left = feet.x - wp / 2, top = feet.y - hp;
        if (cx > left + wp * 0.12 && cx < left + wp * 0.92 && cy > top + hp * 0.03 && cy < feet.y - hp * 0.02) {
          hitHerBody(); return;
        }
      }
    }
  }
  let hold = null;
  for (const g of S.targets) {
    if (g.type !== 'hold' || g.hit || g.grabbed) continue;
    const rDeg = Math.atan2(g.rw, Math.hypot(g.z - cam.z, g.x - cam.x)) / RAD;
    if (aimAngleTo(g.x, g.y, g.z) < rDeg) { hold = g; break; }
  }
  if (hold) { S.holding = hold; hold.grabbed = true; return; }
  fire();
}
function fire() {
  S.muzzle = 1;
  let best = null, bd = 1e9;
  for (const g of S.targets) {
    if (g.hit || g.type === 'hold') continue;
    const dist = Math.hypot(g.x - cam.x, g.y - cam.y, g.z - cam.z);
    const rDeg = Math.atan2(g.rw, dist) / RAD;
    const a = aimAngleTo(g.x, g.y, g.z);
    if (a < rDeg && a < bd) { bd = a; best = g; }
  }
  if (!best && S.her && S.t - S.her.t0 > 0.3) {
    const B = basis();
    const kk = (W / 2) / Math.tan(FOVH / 2 * RAD);
    const bp = project3(S.her.x, BOARD_Y, S.her.z, B);
    if (bp) {
      const rPx = (BOARD_R / bp.z) * kk;
      const d = Math.hypot(W / 2 - bp.x, H / 2 - bp.y);
      if (d < rPx * 2.2) { S.her.surpriseT = 0.8; }
    }
  }
  if (best) {
    best.hit = true;
    const B = basis();
    const hp = project3(best.x, best.y, best.z, B);
    if (hp) S.sparks.push({ x: hp.x, y: hp.y, t: 0, r: (best.rw / hp.z) * ((W / 2) / Math.tan(FOVH / 2 * RAD)) * 1.2 });
    const dist = Math.hypot(best.x - cam.x, best.y - cam.y, best.z - cam.z);
    const perfect = bd < (Math.atan2(best.rw, dist) / RAD) * 0.45;
    if (perfect) S.perfects++;
    S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
    S.score += Math.round(100 * comboMult() * (perfect ? 1.3 : 1));
    S.hits++; S.flash = 0.5;
    if (hp) S.popups.push({ x: hp.x, y: hp.y, t: 0, text: (S.t - best.born).toFixed(2) + 's', color: perfect ? '255,225,140' : '200,235,255' });
    sfx.hit(perfect, { x: best.x, y: best.y, z: best.z });
  }
}
function releaseHold() {
  const g = S.holding;
  if (!g) return;
  S.holding = null;
  if (g.progress >= g.dur * 0.9) {
    g.hit = true; S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
    S.score += Math.round(260 * comboMult()); S.hits++;
    S.popups.push({ x: W / 2, y: H / 2 - 70, t: 0, text: '跟枪 OK', color: '255,220,120' });
    sfx.board();
  } else {
    g.hit = true; S.combo = 0; S.misses++; sfx.miss();
  }
}
function hitHerBoard() {
  const h = S.her;
  h.board = true; h.smileT = 0.7; S.herBoard++;
  S.score += Math.round(500 * comboMult()); S.hits++;
  S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
  sfx.board({ x: h.x, y: BOARD_Y, z: h.z }); showMsg('打中了！好厉害～');
  if (!DEBUG) setTimeout(() => { if (S.her === h) S.her = null; }, 400);
}
function hitHerBody() {
  const h = S.her;
  h.body = true; h.xeye = 1.5; h.pout = 1; h.board = true;   // 牌子一起收起来，不能回头补
  S.herHit++; S.combo = 0; S.misses++;
  S.score = Math.max(0, S.score - 300);
  S.shake = 1; S.herPoutUntil = S.t + 3.2;
  sfx.her({ x: h.x, y: 1.5, z: h.z }); showMsg('唔…前辈好过分。');
  if (!DEBUG) setTimeout(() => { if (S.her === h) S.her = null; }, 900);
}

/* ---------- 更新 ---------- */
function update(dt) {
  if (DEBUG) S.clock += dt;
  const t = nowT();
  S.t = t;
  while (S.evPtr < CHART.events.length && CHART.events[S.evPtr].t <= t + 0.02) {
    const ev = CHART.events[S.evPtr]; S.evPtr++;
    if ((ev.d || 1) > S.diffLevel) continue;              // 难度过滤
    const holdBusy = S.targets.some(g => g.type === 'hold' && !g.hit);
    if (holdBusy && ev.type !== 'hold') continue;       // 一个准星忙不过来：跟枪时不出别的球
    spawnTarget(ev);
  }
  while (S.herPtr < CHART.her.length && CHART.her[S.herPtr].t <= t + 0.02) {
    spawnHer(CHART.her[S.herPtr]); S.herPtr++;
  }
  while (S.beatPtr < CHART.beats.length && CHART.beats[S.beatPtr] <= t) {
    S.beatFlash = 1; S.beatPtr++;
  }

  for (const g of S.targets) {
    if (g.hit) continue;
    if (g.type === 'hold') {
      // 让它动：八字轨迹，玩家得一直跟着
      const el = S.t - g.born;
      g.x = clamp(g.bx + Math.sin(el * g.ampW + g.phase) * g.ax, -8.5, 8.5);
      g.y = clamp(g.by + Math.cos(el * g.ampW * 0.72 + g.phase) * g.ay, 0.9, 6.2);
      if (g.grabbed && S.holding === g) {
        const rDeg = Math.atan2(g.rw, Math.hypot(g.z - cam.z, g.x - cam.x)) / RAD;
        if (aimAngleTo(g.x, g.y, g.z) < rDeg * 1.15) g.progress += dt;
        else g.progress -= dt * 1.4;
        if (g.progress >= g.dur) releaseHold();
        else if (g.progress < -0.15) { g.hit = true; S.holding = null; S.combo = 0; S.misses++; sfx.miss(); }
      } else if (S.t - g.born > g.dur + 0.15) {
        g.hit = true; if (S.holding === g) S.holding = null; S.combo = 0; S.misses++; sfx.miss();
      }
    } else if (S.t - g.born > g.life) {
      g.hit = true; S.combo = 0; S.misses++; sfx.miss();
    }
  }
  S.targets = S.targets.filter(g => !g.hit || S.holding === g);

  if (S.her && DEBUG && (S.her.board || S.her.body) && S.t - S.her.t0 > 2.4) S.her = null;
  if (S.her && S.t - S.her.t0 > 3.4) {
    if (!S.her.body && !S.her.board) showMsg('没打中呢。');
    S.her = null;
  }
  if (S.her) {
    S.her.xeye = Math.max(0, S.her.xeye - dt);
    S.her.surpriseT = Math.max(0, S.her.surpriseT - dt);
    S.her.smileT = Math.max(0, S.her.smileT - dt);
  }
  for (const sp of S.sparks) sp.t += dt;
  for (const pu of S.popups) pu.t += dt;
  S.popups = S.popups.filter(pu => pu.t < (DEBUG ? 6 : 0.9));
  S.sparks = S.sparks.filter(sp => sp.t < 0.35);

  S.shake = Math.max(0, S.shake - dt * 3);
  S.flash = Math.max(0, S.flash - dt * 4);
  S.beatFlash = Math.max(0, S.beatFlash - dt * 4);
  S.muzzle = Math.max(0, S.muzzle - dt * 8);

  updateThreats(dt);
  if (S.t > (S.nextMio || 32) && !S.mio && !S.her) { mioSpawn(); S.nextMio = S.t + 34 + Math.random() * 18; }
  mioUpdate(dt);
  if (AUTO) autoPlay(dt);
}

/* 自测用 */
let autoT = 0, herSeen = 0, herDone = false;
function autoPlay(dt) {
  autoT += dt;
  const h = S.her;
  if (h && S.t - h.t0 > 1.0 && !herDone) {
    herDone = true; herSeen++;
    if (AUTO === 'body' || AUTO === 'clickbody' || (AUTO !== 'board' && herSeen % 2 === 0)) hitHerBody();
    else hitHerBoard();
    return;
  }
  if (!h) herDone = false;
  let best = null, bd = 1e9;
  for (const g of S.targets) {
    if (g.hit || g.type === 'hold') continue;
    const a = aimAngleTo(g.x, g.y, g.z);
    if (a < bd) { bd = a; best = g; }
  }
  if (!best) return;
  const wantYaw = Math.atan2(best.x - cam.x, -(best.z - cam.z)) * 180 / Math.PI;
  const wantPitch = Math.atan2(best.y - cam.y, Math.hypot(best.x - cam.x, best.z - cam.z)) * 180 / Math.PI;
  cam.yaw = clamp(cam.yaw + clamp(wantYaw - cam.yaw, -6, 6), -VIEW_YAW, VIEW_YAW);
  cam.pitch = clamp(cam.pitch + clamp(wantPitch - cam.pitch, -6, 6), -VIEW_PITCH, VIEW_PITCH);
  if (aimAngleTo(best.x, best.y, best.z) < 1.2 && autoT > 0.15) { fire(); autoT = 0; }
}

/* ---------- 绘制 ---------- */
function line3(B, a, b, style, width) {
  const pa = project3(a[0], a[1], a[2], B), pb = project3(b[0], b[1], b[2], B);
  if (!pa || !pb) return;
  ctx.strokeStyle = style; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
}

function drawRoom(B) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#03060d');
  g.addColorStop(0.5, '#07101f');
  g.addColorStop(1, '#0a1526');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  const zBack = -ROOM.d, xL = -ROOM.w / 2, xR = ROOM.w / 2;

  const c1 = project3(xL, 0, zBack, B), c2 = project3(xR, 0, zBack, B);
  const c3 = project3(xR, ROOM.h, zBack, B), c4 = project3(xL, ROOM.h, zBack, B);
  if (c1 && c2 && c3 && c4) {
    ctx.fillStyle = '#081429';
    ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y); ctx.lineTo(c4.x, c4.y); ctx.closePath(); ctx.fill();
    const p1 = project3(-7, 1, zBack + 0.05, B), p2 = project3(7, 1, zBack + 0.05, B);
    const p3 = project3(7, 6.4, zBack + 0.05, B), p4 = project3(-7, 6.4, zBack + 0.05, B);
    if (S.screenMode === 0 && p1 && p2 && p3 && p4) {
      ctx.fillStyle = 'rgba(30,60,110,0.35)';
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(120,190,255,0.55)'; ctx.lineWidth = 2; ctx.stroke();
      // 靶区格子：给玩家一个"这是场地"的参照系
      for (let gx = -6; gx <= 6; gx += 2) line3(B, [gx, 1, zBack + 0.04], [gx, 6.4, zBack + 0.04], 'rgba(110,170,255,0.12)', 1);
      for (let gy = 2.08; gy < 6.4; gy += 1.08) line3(B, [-7, gy, zBack + 0.04], [7, gy, zBack + 0.04], 'rgba(110,170,255,0.12)', 1);
    }
  }

  const zRear = 3.0;
  // 身后那面墙
  const r1 = project3(xL, 0, zRear, B), r2 = project3(xR, 0, zRear, B);
  const r3 = project3(xR, ROOM.h, zRear, B), r4 = project3(xL, ROOM.h, zRear, B);
  if (r1 && r2 && r3 && r4) {
    ctx.fillStyle = '#050a14';
    ctx.beginPath(); ctx.moveTo(r1.x, r1.y); ctx.lineTo(r2.x, r2.y);
    ctx.lineTo(r3.x, r3.y); ctx.lineTo(r4.x, r4.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(110,170,255,0.16)'; ctx.lineWidth = 2; ctx.stroke();
    for (let x = -8; x <= 8; x += 4) line3(B, [x, 0, zRear], [x, ROOM.h, zRear], 'rgba(90,140,220,0.10)', 1);
  }
  for (let x = -8; x <= 8; x += 2) line3(B, [x, 0, zRear], [x, 0, zBack], 'rgba(90,140,220,0.13)', 1);
  for (let z = zRear; z >= zBack; z -= 2) line3(B, [xL, 0, z], [xR, 0, z], 'rgba(90,140,220,0.13)', 1);
  for (let x = -8; x <= 8; x += 4) line3(B, [x, 0, zBack], [x, ROOM.h, zBack], 'rgba(90,140,220,0.10)', 1);
  line3(B, [xL, 3.5, zBack], [xR, 3.5, zBack], 'rgba(90,140,220,0.10)', 1);

  for (let z = 3; z >= zBack; z -= 3) {
    line3(B, [xL, 0, z], [xL, ROOM.h, z], 'rgba(90,140,220,0.10)', 1);
    line3(B, [xR, 0, z], [xR, ROOM.h, z], 'rgba(90,140,220,0.10)', 1);
  }
  line3(B, [xL, ROOM.h, 3], [xL, ROOM.h, zBack], 'rgba(90,140,220,0.12)', 1);
  line3(B, [xR, ROOM.h, 3], [xR, ROOM.h, zBack], 'rgba(90,140,220,0.12)', 1);

  for (const lx of [-3, 3]) {
    line3(B, [lx, ROOM.h - 0.15, -1], [lx, ROOM.h - 0.15, zBack], 'rgba(150,205,255,0.20)', 2);
  }
  for (const cx of [xL, xR]) {
    line3(B, [cx, 0, zBack], [cx, ROOM.h, zBack], 'rgba(120,180,255,0.28)', 2);
    line3(B, [cx, 0, 0], [cx, 0, zBack], 'rgba(120,180,255,0.18)', 2);
    line3(B, [cx, ROOM.h, 0], [cx, ROOM.h, zBack], 'rgba(120,180,255,0.18)', 2);
  }
  line3(B, [xL, 0, -1.2], [xR, 0, -1.2], 'rgba(120,180,255,0.30)', 2);

  if (S.screenMode !== 0) drawMedia(B);
}

function drawHer(B) {
  if (!S.her) return;
  const h = herAnchor();
  const feet = project3(h.x, 0, h.z, B);
  if (!feet) return;
  const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
  const hp = (HER_H / feet.z) * k;
  const wp = hp * 0.53;
  const kind = h.xeye > 0.02 ? 'xeye' : (h.body ? 'pout' : (h.smileT > 0 ? 'smile' : (h.surpriseT > 0 ? 'surprise' : 'base')));
  const img = spriteFor(kind);

  // 身后柔光
  const gx = feet.x, gy = feet.y - hp * 0.55;
  const gl = ctx.createRadialGradient(gx, gy, hp * 0.04, gx, gy, hp * 0.62);
  gl.addColorStop(0, 'rgba(110,165,235,0.26)');
  gl.addColorStop(1, 'rgba(110,165,235,0)');
  ctx.fillStyle = gl;
  ctx.beginPath(); ctx.arc(gx, gy, hp * 0.62, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  if (h.xeye > 0) ctx.filter = 'drop-shadow(0 0 26px rgba(255,70,90,.55))';
  ctx.drawImage(img, feet.x - wp / 2, feet.y - hp, wp, hp);
  ctx.restore();

  if (h.xeye > 0.02) {
    const ex = feet.x - wp / 2 + wp * 0.448, ey = feet.y - hp + hp * 0.145;
    const d = wp * 0.043, s = wp * 0.029;
    ctx.strokeStyle = 'rgba(255,60,70,' + h.xeye + ')';
    ctx.lineWidth = Math.max(3, wp * 0.012);
    for (const ox of [-d, d]) {
      ctx.beginPath();
      ctx.moveTo(ex + ox - s, ey - s); ctx.lineTo(ex + ox + s, ey + s);
      ctx.moveTo(ex + ox + s, ey - s); ctx.lineTo(ex + ox - s, ey + s);
      ctx.stroke();
    }
  }

  // 牌子已经画在立绘里了，这里只画一圈"可打"的高亮
  const bp = project3(h.x, BOARD_Y, h.z, B);
  if (bp && !h.board && !h.body) {
    const rPx = (BOARD_R / bp.z) * k;
    const pulse = 0.5 + 0.5 * Math.sin(S.t * Math.PI * 2 / BEAT);
    ctx.beginPath(); ctx.arc(bp.x, bp.y, rPx * 1.08, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,120,130,' + (0.25 + 0.35 * pulse) + ')';
    ctx.lineWidth = 2; ctx.stroke();
  }
}

function drawTargets(B) {
  const k = (W / 2) / Math.tan(FOVH / 2 * RAD);
  const list = [];
  for (const g of S.targets) {
    if (g.hit) continue;
    const p = project3(g.x, g.y, g.z, B);
    if (!p) continue;
    list.push({ g, p, r: (g.rw / p.z) * k });
  }
  list.sort((a, b) => b.p.z - a.p.z);
  for (const { g, p, r } of list) {
    const age = S.t - g.born;
    const left = g.type === 'hold' ? (g.dur - g.progress) : (g.life - age);
    const near = 1 - Math.min(1, left / (BEAT * 1.2));
    ctx.save();
    ctx.translate(p.x, p.y);
    if (g.type === 'hold') {
      const pr = g.dur ? clamp(g.progress / g.dur, 0, 1) : 0;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,200,90,0.9)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr);
      ctx.strokeStyle = 'rgba(255,240,180,1)'; ctx.lineWidth = 7; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,220,120,' + (0.5 + 0.5 * pr) + ')'; ctx.fill();
    } else {
      const col = g.fast ? '255,120,140' : '120,220,255';
      ctx.shadowColor = 'rgba(' + col + ',0.75)'; ctx.shadowBlur = 18 + near * 16;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + col + ',' + (0.16 + 0.25 * near) + ')'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(' + col + ',0.95)'; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + col + ',' + (0.35 + 0.4 * near) + ')'; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + col + ',' + (0.10 + 0.25 * near) + ')'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.restore();
  }
}

function drawCrosshair() {
  const cx = W / 2, cy = H / 2;
  ctx.strokeStyle = 'rgba(230,245,255,0.95)'; ctx.lineWidth = 2;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * 6, cy + dy * 6);
    ctx.lineTo(cx + dx * 13, cy + dy * 13);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fill();
}

function render() {
  const hudEl2 = document.getElementById('hud'); if (hudEl2) hudEl2.style.display = '';
  const B = basis();
  ctx.save();
  if (S.shake > 0) ctx.translate((Math.random() - 0.5) * 18 * S.shake, (Math.random() - 0.5) * 18 * S.shake);
  drawRoom(B);
  drawHer(B);
  drawTargets(B);
  drawThreats(B);
  drawClaudePeek();
  drawMio();
  for (const sp of S.sparks) {
    const k2 = Math.max(0, 1 - sp.t / 0.35);
    ctx.beginPath(); ctx.arc(sp.x, sp.y, sp.r * (0.5 + 1.1 * (1 - k2)), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(190,235,255,' + (0.7 * k2) + ')'; ctx.lineWidth = 3; ctx.stroke();
  }
  for (const pu of S.popups) {
    const k = Math.max(0, 1 - pu.t / 0.9);
    ctx.save();
    ctx.globalAlpha = k;
    ctx.font = 'bold 22px "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(' + pu.color + ',1)';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 6;
    ctx.fillText(pu.text, pu.x, pu.y - 26 - 20 * pu.t);
    ctx.restore();
  }
  if (S.muzzle > 0) {
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 26 * S.muzzle, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180,220,255,' + 0.16 * S.muzzle + ')'; ctx.fill();
  }
  drawCrosshair();
  ctx.restore();

  if (S.beatFlash > 0) {
    ctx.fillStyle = 'rgba(120,180,255,' + 0.04 * S.beatFlash + ')';
    ctx.fillRect(0, 0, W, H);
  }
  drawThreatOverlays();
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.4)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

  $score.textContent = S.score;
  $sub.textContent = '命中 ' + S.hits + '　连击 ' + S.combo + '　漏 ' + S.misses;
  $sub.style.color = S.combo >= 10 ? '#9fe0ff' : '';
  const total = S.hits + S.misses;
  $acc.textContent = '准确率 ' + (total ? Math.round(S.hits / total * 100) : 100) + '%';
  const tt = Math.max(0, CHART.duration - nowT());
  $time.textContent = Math.floor(tt / 60) + ':' + String(Math.floor(tt % 60)).padStart(2, '0');
  $combo.textContent = S.holding ? '跟枪中…（按住）' : '';
  if (performance.now() > S.msgUntil && $msg.style.opacity !== '0') $msg.style.opacity = '0';
}

/* ---------- 每首歌自己的 MV ---------- */
function loadVideoFor(song) {
  if (SCREEN.video) {
    try { SCREEN.video.pause(); } catch (e) { }
    if (SCREEN.video.parentNode) SCREEN.video.parentNode.removeChild(SCREEN.video);
    SCREEN.video = null;
  }
  SCREEN.pendingMV = null;
  if (!song || !song.mv) return;
  const v = document.createElement('video');
  v.muted = true; v.loop = false; v.playsInline = true; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:0';
  document.body.appendChild(v);
  v.addEventListener('loadeddata', () => { SCREEN.video = v; });
  v.addEventListener('error', () => { SCREEN.video = null; });
  v.src = song.mv;
  v.load();
  SCREEN.videoEl = v;
}
function ensureVideo() { }

/* ---------- MV 跟音乐对齐 ---------- */
function syncVideo() {
  const v = SCREEN.video;
  if (!v || v.readyState < 1) return;
  const want = S.screenMode === 2 && S.running && !S.paused;
  if (!want) { if (!v.paused) v.pause(); return; }
  const songOff = (currentSong() && currentSong().mvOffset) || 0;
  const t = nowT() + MV_OFFSET + songOff;

  // 数据还没到位时不要 seek：网络环境下 seek 会让元素卡在"等待数据"状态
  if (v.readyState < 2) {
    if (v.paused && v.error === null) v.play().catch(() => { });
    return;
  }
  if (v.paused) {
    if (v.currentTime === 0 && t > 0.2) v.currentTime = Math.max(0, t);
    v.play().catch(() => { });
    S.videoStallT = 0;
    return;
  }
  // 正在 seek 就别再插手，否则每帧重置播放头 = 永远播不动
  if (v.seeking) return;
  // 只在明显漂移时纠正，且一秒最多纠正一次
  if (Math.abs(v.currentTime - t) > 1.2 && (S.t - (S.mvSeekAt || 0)) > 1.0) {
    S.mvSeekAt = S.t;
    v.currentTime = Math.max(0, t);
  }
}


/* ---------- 主菜单：转动的曲目盘 ---------- */
function drawVinyl(cx, cy, r, ang, img) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = 'rgba(80,140,230,.35)'; ctx.shadowBlur = 46;
  const grad = ctx.createRadialGradient(0, 0, r * 0.14, 0, 0, r);
  grad.addColorStop(0, '#161b28'); grad.addColorStop(0.68, '#0a0d15'); grad.addColorStop(1, '#04060b');
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(140,180,255,0.055)'; ctx.lineWidth = 1;
  for (let i = 1; i <= 22; i++) { ctx.beginPath(); ctx.arc(0, 0, r * (0.30 + i * 0.031), 0, Math.PI * 2); ctx.stroke(); }
  ctx.save(); ctx.rotate(ang * 0.7);
  const sh = ctx.createLinearGradient(-r, -r, r, r);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(0.44, 'rgba(180,220,255,0.05)');
  sh.addColorStop(0.5, 'rgba(225,240,255,0.13)');
  sh.addColorStop(0.56, 'rgba(180,220,255,0.05)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = sh; ctx.fill();
  ctx.restore();
  if (img && img.complete && img.naturalWidth) {
    ctx.save(); ctx.rotate(ang);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.40, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, -r * 0.40, -r * 0.40, r * 0.80, r * 0.80);
    ctx.restore();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.40, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(150,190,255,0.35)'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, r * 0.035, 0, Math.PI * 2); ctx.fillStyle = '#0b0e16'; ctx.fill();
  ctx.restore();
}

function pill(x, y, w, h, label, on) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = on ? 'rgba(90,150,255,0.22)' : 'rgba(255,255,255,0.03)';
  ctx.fill();
  ctx.strokeStyle = on ? 'rgba(140,195,255,0.85)' : 'rgba(120,150,200,0.35)';
  ctx.lineWidth = on ? 2 : 1;
  ctx.stroke();
  ctx.fillStyle = on ? '#eaf2ff' : '#7f95b8';
  ctx.font = (on ? 'bold ' : '') + '17px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);
}

function songNow() { return MENU.songs[MENU.idx]; }

const ALBUM = (function () {
  const d = { x: 0.628, y: 0.070, w: 0.340, h: 0.296, rot: 0.075 };
  const q = new URLSearchParams(location.search).get('alb');
  if (q) {
    const a = q.split(',').map(Number);
    if (a.length >= 5 && a.every(n => !isNaN(n))) { d.x = a[0]; d.y = a[1]; d.w = a[2]; d.h = a[3]; d.rot = a[4]; }
  }
  return d;
})();   // 立绘上那块板子的位置（比例）
const herAlbumImg = new Image();
herAlbumImg.src = 'her_album.png';

const PREVIEW = { timer: null };
function previewSong(song) {
  if (DEBUG || !song) return;
  try {
    clearTimeout(PREVIEW.timer);
    audio.pause();
    audio.volume = 0.35;
    audio.src = song.audio;
    const seek = () => {
      try { audio.currentTime = 30; } catch (e) { }
      audio.play().catch(() => { });
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
    PREVIEW.timer = setTimeout(() => audio.pause(), 7000);
  } catch (e) { console.warn('preview failed', e); }
}

function switchSong(dir) {
  const n = MENU.songs.length || 1;
  MENU.pendingIdx = (MENU.idx + dir + n) % n;
  MENU.flip = 1;
  MENU.mood = 1.6;
}

function drawAlbum(sx, sy, sw, sh) {
  const ax = sx + ALBUM.x * sw, ay = sy + ALBUM.y * sh;
  const aw = ALBUM.w * sw, ah = ALBUM.h * sh;
  const cx = ax + aw / 2, cy = ay + ah / 2;
  const flip = Math.min(1, Math.max(0, MENU.flip || 0));
  const k = Math.abs(1 - 2 * flip);                 // 1 → 0 → 1
  const cover = MENU.covers[MENU.idx];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ALBUM.rot);
  ctx.scale(Math.max(0.02, k), 1);
  if (cover && cover.complete && cover.naturalWidth) {
    ctx.drawImage(cover, -aw / 2, -ah / 2, aw, ah);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 2;
    ctx.strokeRect(-aw / 2, -ah / 2, aw, ah);
  } else {
    ctx.fillStyle = '#e9e4d8'; ctx.fillRect(-aw / 2, -ah / 2, aw, ah);
  }
  ctx.restore();
}

function renderMenu(dt) {
  const hudM = document.getElementById('hud'); if (hudM) hudM.style.display = 'none';
  const t = performance.now() / 1000;
  MENU.angle += dt * 0.55;
  MENU.mood = Math.max(0, (MENU.mood || 0) - dt);

  // 翻面：走到最窄的时候换封面
  MENU.flip = Math.max(0, (MENU.flip || 0) - dt * 2.4);
  const _fq = new URLSearchParams(location.search).get('flip');
  if (_fq) MENU.flip = parseFloat(_fq);
  if (MENU.pendingIdx != null && MENU.flip < 0.5) {
    MENU.idx = MENU.pendingIdx;
    MENU.pendingIdx = null;
    previewSong(currentSong());
  }

  // 背景：深色舞台 + 两团光
  ctx.fillStyle = '#05070f'; ctx.fillRect(0, 0, W, H);
  const g1 = ctx.createRadialGradient(W * 0.68, H * 0.42, 10, W * 0.68, H * 0.42, Math.max(W, H) * 0.75);
  g1.addColorStop(0, 'rgba(36,72,132,0.42)'); g1.addColorStop(1, 'rgba(5,7,15,0)');
  ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
  const g2 = ctx.createRadialGradient(W * 0.18, H * 0.85, 10, W * 0.18, H * 0.85, Math.max(W, H) * 0.5);
  g2.addColorStop(0, 'rgba(18,40,80,0.30)'); g2.addColorStop(1, 'rgba(5,7,15,0)');
  ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
  const gf = ctx.createLinearGradient(0, H * 0.72, 0, H);
  gf.addColorStop(0, 'rgba(90,150,230,0.10)'); gf.addColorStop(1, 'rgba(90,150,230,0)');
  ctx.fillStyle = gf; ctx.fillRect(0, H * 0.72, W, H * 0.28);

  // 粒子（按曲子变色）
  const petalC = (MENU.songs[MENU.idx] && MENU.songs[MENU.idx].id === 'haru')
    ? 'rgba(255,196,220,0.30)' : 'rgba(165,210,255,0.20)';
  for (const q of MENU.petals) {
    q.y += q.vy * dt;
    q.x += Math.sin((t + q.ph) * 1.2) * 0.35 * dt * 60;
    if (q.y > H + 10) { q.y = -10; q.x = Math.random() * W; }
    ctx.beginPath();
    ctx.ellipse(q.x, q.y, q.r, q.r * 0.55, q.a + t * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = petalC; ctx.shadowColor = petalC; ctx.shadowBlur = 8;
    ctx.fill(); ctx.shadowBlur = 0;
  }

  // 她：站在右侧，手里举着专辑
  const sh = H * 0.96;
  const sw = sh * (814 / 1208);
  const sx = W * 0.655 - sw / 2 + Math.sin(t * 0.9) * 3;
  const sy = H - sh - H * 0.01;
  ctx.save();
  // 换专辑的时候她跟着轻轻扭一下，别只有封面在动
  const twist = (MENU.flip || 0);
  ctx.translate(sx + sw * 0.55, sy + sh * 0.62);
  ctx.rotate(-0.035 * twist);
  ctx.translate(-(sx + sw * 0.55) + 10 * twist, -(sy + sh * 0.62) - 2 * twist);
  ctx.drawImage(herAlbumImg, sx, sy, sw, sh);
  ctx.restore();
  drawAlbum(sx + 10 * twist, sy - 2 * twist, sw, sh);

  // 文字层
  const song = currentSong();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 16;
  ctx.fillStyle = '#8fb2e0'; ctx.font = '15px "Microsoft YaHei", sans-serif';
  ctx.fillText('ヨルシカ · 节奏射击', W * 0.06, H * 0.15);
  ctx.fillStyle = '#f2f7ff'; ctx.font = 'bold 56px "Microsoft YaHei", sans-serif';
  ctx.fillText(song ? song.title : '—', W * 0.06, H * 0.26);
  ctx.fillStyle = '#9fc0ea'; ctx.font = '16px "Microsoft YaHei", sans-serif';
  if (song) ctx.fillText(song.artist + '　·　第 ' + (MENU.idx + 1) + ' / ' + MENU.songs.length + ' 首', W * 0.06, H * 0.33);
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#8fb2e0'; ctx.font = '14px "Microsoft YaHei", sans-serif';
  ctx.fillText('难度', W * 0.06, H * 0.43);
  for (let i = 0; i < 3; i++) pill(W * 0.06 + i * 108, H * 0.455, 96, 38, DIFF_NAMES[i], MENU.diff === i);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#6d82a8'; ctx.font = '13px "Microsoft YaHei", sans-serif';
  ctx.fillText('← →  换专辑　　↑ ↓ / 1 2 3  难度　　Enter  开始　　S  灵敏度　　M  后屏', W * 0.06, H * 0.93);
}

// 菜单粒子：第一次进菜单时生成

MENU.mood = 0;
MENU.petals = (function () {
  const arr = [];
  for (let i = 0; i < 46; i++) {
    arr.push({
      x: Math.random() * 1400, y: Math.random() * 800,
      r: 2.2 + Math.random() * 4.2, vy: 14 + Math.random() * 34,
      a: Math.random() * Math.PI, ph: Math.random() * 10,
      c: 'rgba(255,196,220,0.30)'
    });
  }
  return arr;
})();

/* ---------- 开始游戏 ---------- */

/* ---------- 灵敏度面板 ---------- */
const $sensPanel = document.getElementById('settings');
function refreshSensPanel() {
  if (!$sensPanel) return;
  const a = document.getElementById('in-sens'), b = document.getElementById('in-dpi');
  if (a) a.value = VALO.sens;
  if (b) b.value = VALO.dpi;
  const info = document.getElementById('calc');
  if (info) info.innerHTML = 'eDPI <b>' + Math.round(VALO.sens * VALO.dpi) +
    '</b>　·　转 360° 需要 <b>' + cmPer360().toFixed(1) + ' cm</b><br>' +
    '<span style="color:#7f94bb;font-size:13px">按同样的手部距离转身，和无畏契约一致　·　游戏内 ' + degPerUnit().toFixed(4) + '°/像素</span>';
}
function openSensPanel() {
  if (!$sensPanel) return;
  S.paused = true;
  if (S.running) audio.pause();
  refreshSensPanel();
  $sensPanel.style.display = 'flex';
  document.exitPointerLock && document.exitPointerLock();
}
function closeSensPanel() {
  if (!$sensPanel) return;
  $sensPanel.style.display = 'none';
}
(function bindSensPanel() {
  if (!$sensPanel) return;
  const a = document.getElementById('in-sens'), b = document.getElementById('in-dpi');
  const apply = document.getElementById('apply-sens');
  apply && apply.addEventListener('click', () => {
    const sv = parseFloat(a.value), dv = parseFloat(b.value);
    if (isFinite(sv) && sv > 0) VALO.sens = Math.min(3, Math.max(0.02, sv));
    if (isFinite(dv) && dv >= 100) VALO.dpi = dv;
    applySens();
    refreshSensPanel();
    closeSensPanel();
    if (S.running) {
      const p = document.getElementById('pause');
      if (p) p.style.display = 'flex';
    }
  });
})();
applySens();

/* ---------- 主循环 ---------- */
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  S.frames = (S.frames || 0) + 1;
  window.__frames = S.frames;
  try {
    if (S.running && !S.paused) update(dt);
    if (S.screenMode === 2 && !SCREEN.videoEl) ensureVideo();
  syncVideo();
  updateListener();
  if (S.running && !S.paused && audio.paused && audio.readyState >= 3 && !audio.ended) {
    S.audioStuck = (S.audioStuck || 0) + dt;
    if (S.audioStuck > 0.5) { audio.play().catch(() => { }); S.audioStuck = 0; }
  } else { S.audioStuck = 0; }
    if (S.running) render(); else renderMenu(dt);
  } catch (err) {
    // 画面里出错也别让 loop 停掉，否则看起来就是"卡死"
    if (!S.lastErr || S.frames - S.lastErrFrame > 120) {
      console.error('frame error:', err);
      S.lastErr = String(err);
      S.lastErrFrame = S.frames;
    }
  }
  requestAnimationFrame(loop);
}
audio.addEventListener('ended', finish);
resize();
requestAnimationFrame(loop);
if (DEBUG) setTimeout(startGame, 60);
if (PARAMS.has('pause')) setTimeout(() => { if (S.running) { S.paused = true; const p = document.getElementById('pause'); if (p) p.style.display = 'flex'; } }, 300);
if (PARAMS.has('settings')) setTimeout(openSensPanel, 80);

window.__probe = () => ({ frames: S.frames || 0,
  t: +nowT().toFixed(2), running: S.running, paused: S.paused,
  targets: S.targets.length, ev: S.evPtr, herPtr: S.herPtr,
  score: S.score, herOn: !!S.her, bpm: CHART ? CHART.bpm : 0,
  video: SCREEN.video ? { t: +SCREEN.video.currentTime.toFixed(2), paused: SCREEN.video.paused } : null, mode: S.screenMode, mvoff: MV_OFFSET,
  herBoard: S.herBoard, herHit: S.herHit, combo: S.combo, popups: S.popups.length, hits: S.hits, misses: S.misses, mood: S.her ? (S.her.xeye > 0.02 ? 'xeye' : S.her.body ? 'pout' : S.her.smileT > 0 ? 'smile' : S.her.surpriseT > 0 ? 'surprise' : 'base') : '-'
});

/* ---------- 后屏：专辑封面 / MV ---------- */
const SCREEN = {
  cover: new Image(),
  video: null,
  tex: document.createElement('canvas'),
  texCtx: null
};
SCREEN.texCtx = SCREEN.tex.getContext('2d');
SCREEN.cover.src = 'cover.jpg';
(function loadMv() {
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
  v.addEventListener('loadeddata', () => { SCREEN.video = v; });
  v.addEventListener('error', () => { SCREEN.video = null; });
  v.src = 'mv.mp4';
  v.load();
})();

/** 把一块贴图按透视贴到平面上（拆小格子 + 两个三角形近似） */
function triDraw(img, s0, s1, s2, d0, d1, d2) {
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(den) < 1e-6) return;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  // 三角形稍微外扩一点，盖住相邻三角形之间的抗锯齿缝（不然图上有细斜线）
  const cxm = (d0.x + d1.x + d2.x) / 3, cym = (d0.y + d1.y + d2.y) / 3;
  const k = 1.06;
  const e0 = { x: cxm + (d0.x - cxm) * k, y: cym + (d0.y - cym) * k };
  const e1 = { x: cxm + (d1.x - cxm) * k, y: cym + (d1.y - cym) * k };
  const e2 = { x: cxm + (d2.x - cxm) * k, y: cym + (d2.y - cym) * k };
  ctx.save();
  ctx.beginPath(); ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y); ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawPlane(B, img, x0, x1, y0, y1, z, GX, GY) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  if (!sw || !sh) return;
  for (let ix = 0; ix < GX; ix++) {
    for (let iy = 0; iy < GY; iy++) {
      const ax = x0 + (x1 - x0) * ix / GX, bx = x0 + (x1 - x0) * (ix + 1) / GX;
      const ay = y0 + (y1 - y0) * iy / GY, by = y0 + (y1 - y0) * (iy + 1) / GY;
      const p00 = project3(ax, ay, z, B), p10 = project3(bx, ay, z, B);
      const p01 = project3(ax, by, z, B), p11 = project3(bx, by, z, B);
      if (!p00 || !p10 || !p01 || !p11) continue;
      // 注意：贴图的 y 朝下、世界的 y 朝上，这里要翻过来，否则图是倒的
      const v0 = sh * (1 - iy / GY), v1 = sh * (1 - (iy + 1) / GY);
      const s00 = { x: sw * ix / GX, y: v0 };
      const s10 = { x: sw * (ix + 1) / GX, y: v0 };
      const s01 = { x: sw * ix / GX, y: v1 };
      const s11 = { x: sw * (ix + 1) / GX, y: v1 };
      triDraw(img, s00, s10, s01, p00, p10, p01);
      triDraw(img, s10, s11, s01, p10, p11, p01);
    }
  }
}

function drawMedia(B) {
  const z = -ROOM.d + 0.08;
  const tex = SCREEN.tex, tc = SCREEN.texCtx;
  let aspect = 1, ready = false;
  if (S.screenMode === 2) {
    if (SCREEN.video && SCREEN.video.readyState >= 2) {
      tex.width = 960; tex.height = 540;
      tc.drawImage(SCREEN.video, 0, 0, 960, 540);
      aspect = 16 / 9; ready = true;
    } else if (SCREEN.cover.complete && SCREEN.cover.naturalWidth) {
      // 没有 mv.mp4 就先放封面，别留一块黑屏
      tex.width = 720; tex.height = 720;
      tc.drawImage(SCREEN.cover, 0, 0, 720, 720);
      aspect = 1; ready = true;
    }
  } else if (S.screenMode === 1) {
    if (SCREEN.cover.complete && SCREEN.cover.naturalWidth) {
      tex.width = 720; tex.height = 720;
      tc.drawImage(SCREEN.cover, 0, 0, 720, 720);
      aspect = 1; ready = true;
    }
  }
  if (!ready) return;

  const hgt = 5.2, wid = hgt * aspect, cy = 3.4;
  const x0 = -wid / 2, x1 = wid / 2, y0 = cy - hgt / 2, y1 = cy + hgt / 2;
  ctx.save();
  drawPlane(B, tex, x0, x1, y0, y1, z, 6, 4);
  ctx.restore();

  // 边框 + 一点点辉光
  const q = [project3(x0, y0, z, B), project3(x1, y0, z, B), project3(x1, y1, z, B), project3(x0, y1, z, B)];
  if (q.every(Boolean)) {
    ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(150,200,255,0.55)'; ctx.lineWidth = 2; ctx.stroke();
  }
}

/* 浏览器要求用户手势才能启动音频；任何一次点击/按键都把上下文唤醒 */
(function unlockAudio() {
  const wake = () => {
    try {
      const a = ac();
      if (a.state === 'suspended') a.resume();
    if (!MUSIC_SRC) attachMusic();
      attachMusic();
      applySongGain(typeof currentSong === 'function' ? currentSong() : null);
    } catch (e) { }
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, wake, { capture: true }));
})();

window.__debug = { knockMio() { if (!S.mio) return 'none'; const p = mioWorldPos(); if (!p) return 'none'; cam.yaw = Math.atan2(p.x - cam.x, -(p.z - cam.z)) * 180 / Math.PI; cam.pitch = Math.atan2(p.y - cam.y, Math.hypot(p.x - cam.x, p.z - cam.z)) * 180 / Math.PI; tryHoldOrFire(); return 'fired'; }, shootThreat() { const g = S.threats.find(x => !x.hit); if (!g) return 'none'; cam.yaw = Math.atan2(g.x, -g.z) * 180 / Math.PI; cam.pitch = Math.atan2(g.y - cam.y, Math.hypot(g.x, g.z)) * 180 / Math.PI; tryHoldOrFire(); return 'fired'; }, setScreen(m) { S.screenMode = m; if (m === 2) ensureVideo(); if (m === 2 && SCREEN.video) { SCREEN.video.currentTime = Math.max(0, nowT() + MV_OFFSET); SCREEN.video.play().catch(() => { }); } } };