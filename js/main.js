// walk the line — web version: core
//
// One canvas shows the original 1024 px wide Director stage.  A scene module
// (handoff.js, paritaet.js, ritter.js) owns its clips and draws them in stage
// coordinates; this file provides the stage, the clock, Web Audio, routing
// between the menu and the scenes, and the idle timer.

import { handoffScene } from './handoff.js';
import { paritaetScene } from './paritaet.js';
import { ritterScene } from './ritter.js';

const DRAG_INFO = 'By dragging the video clips on top of each other the videos overlap and alter space and time.';
const SWAP_INFO = ' Double-click a clip, then click another one to swap them.';

// the five scenes of the original menu that exist in this folder
const SCENES = {
  fussball: () => handoffScene({ url: 'scenes/fussball.json', mode: 'pingpong', rowLeft: 10, info: DRAG_INFO }),
  stadt: () => handoffScene({ url: 'scenes/stadt.json', mode: 'chain', rowLeft: 0, swap: true,
    resetAfter: 30, info: DRAG_INFO + SWAP_INFO }),
  ton: () => handoffScene({ url: 'scenes/ton.json', mode: 'chain', rowLeft: 10, swap: true, layers: true, filler: true,
    startAt: 15 / 60, resetAfter: 15, info: DRAG_INFO + SWAP_INFO }),
  paritaet: () => paritaetScene({ url: 'scenes/paritaet.json', rowLeft: 10,
    info: 'Each video clip offers multiple perspectives on the same action. By clicking on the right or left of each clip you can change the perspective.' }),
  ritter: () => ritterScene({ url: 'scenes/ritter.json', rowLeft: 15,
    info: 'By clicking on one of the three video clips in the middle you change the time of day and the place the two knights will be meeting.' }),
};

// Idle: when nobody has interacted for IDLE_AFTER seconds the scene plays by
// itself (clips slide, perspectives change, the knights get a meeting place).
// Override with ?idle=<seconds>.
export const IDLE_AFTER = Number(new URLSearchParams(location.search).get('idle')) || 20;
export const STAGE_W = 1024, CW = 200, CH = 150;

const canvas = document.getElementById('stage');
const ctx2d = canvas.getContext('2d');
const $ = id => document.getElementById(id);

let audio = null;            // AudioContext, created inside the first click
let scene = null;            // the running scene module
let sceneName = null;
let loadToken = 0;           // guards against switching scenes while one is loading
let lastClock = 0;
let paused = false;          // test hook (wtl.pause)
let debug = false;
let idleT = 0;
let view = { scale: 1, x0: 0, y0: 0, dpr: 1 };

// ---------------------------------------------------------------- environment for scenes

export const env = {
  canvas, ctx2d, CW, CH, STAGE_W,
  get audio() { return audio; },
  get view() { return view; },
  get idle() { return idleT >= IDLE_AFTER; },
  get debug() { return debug; },
  userActed() { idleT = 0; },
  toStage(ev) { return { x: (ev.clientX - view.x0) / view.scale, y: (ev.clientY - view.y0) / view.scale }; },
  setCursor(kind) {
    canvas.classList.toggle('can-grab', kind === 'grab');
    canvas.classList.toggle('grabbing', kind === 'grabbing');
    canvas.classList.toggle('can-click', kind === 'click');
  },
  async loadJSON(url) { return (await fetch(url)).json(); },
  loadImage(url) { const img = new Image(); img.src = url; return img.decode().then(() => img); },
  async loadAudio(url) {
    const data = await (await fetch(url)).arrayBuffer();
    return audio.decodeAudioData(data);
  },
  // play a decoded buffer; returns a handle with stop() / setRate() / setGain()
  play(buffer, { offset = 0, delay = 0, loop = false, rate = 1, gain = 1 } = {}) {
    const src = audio.createBufferSource();
    const g = audio.createGain();
    src.buffer = buffer;
    src.loop = loop;
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(audio.destination);
    src.start(audio.currentTime + Math.max(0, delay), Math.max(0, Math.min(offset, buffer.duration - 0.001)));
    let alive = true;
    src.onended = () => { alive = false; };
    return {
      get alive() { return alive; },
      stop() { if (!alive) return; alive = false; try { src.stop(); } catch (_) {} src.disconnect(); g.disconnect(); },
      setRate(r) { src.playbackRate.value = r; },
      setGain(v, ramp = 0.15) { g.gain.setTargetAtTime(v, audio.currentTime, ramp / 3); },
    };
  },
  // a muted video element kept in the (invisible) DOM so it keeps decoding
  createVideo(url) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    $('videos').append(v);
    return new Promise((res, rej) => {
      if (v.readyState >= 3) return res(v);
      v.addEventListener('canplaythrough', () => res(v), { once: true });
      v.addEventListener('error', () => rej(new Error('video failed: ' + url)), { once: true });
    });
  },
};

// ---------------------------------------------------------------- layout

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const scale = Math.min((innerWidth * 0.96) / STAGE_W, (innerHeight * 0.72) / CH);
  view = { scale, dpr, x0: (innerWidth - STAGE_W * scale) / 2, y0: (innerHeight - CH * scale) / 2 };
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop

function frame() {
  requestAnimationFrame(frame);
  const now = audio ? audio.currentTime : performance.now() / 1000;
  const dt = Math.min(0.1, Math.max(0, now - lastClock));
  lastClock = now;
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.fillStyle = '#000';
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  if (!scene || !scene.running) return;
  if (!paused) {
    idleT += dt;
    scene.update(dt);
  }
  const { scale, dpr, x0, y0 } = view;
  ctx2d.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x0, dpr * y0);
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.imageSmoothingQuality = 'high';
  scene.draw(ctx2d);
}

// ---------------------------------------------------------------- routing

function ensureAudio() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended' && !paused) audio.resume();
  lastClock = audio.currentTime;
}

function showMenu() {
  leaveScene();
  $('menu').classList.remove('hidden');
  $('scene-ui').classList.add('hidden');
  $('start').classList.add('hidden');
}

function leaveScene() {
  loadToken++;
  if (scene) { scene.destroy(); scene = null; }
  sceneName = null;
  delete window.wtl;
  env.setCursor(null);
}

async function enterScene(name) {
  leaveScene();
  $('menu').classList.add('hidden');
  const token = ++loadToken;
  if (!audio) {                                    // deep link: sound needs a click first
    $('status').textContent = 'click to start';
    $('start').classList.remove('hidden');
    await new Promise(res => $('start').addEventListener('click', res, { once: true }));
    if (token !== loadToken) return;
  }
  ensureAudio();
  $('status').textContent = 'loading…';
  $('start').classList.remove('hidden');
  const s = SCENES[name]();
  try {
    await s.load(env, (done, total) => { if (token === loadToken) $('status').textContent = `loading ${done}/${total}`; });
  } catch (e) {
    $('status').textContent = 'could not load media — serve this folder over http (see README)';
    throw e;
  }
  if (token !== loadToken) { s.destroy(); return; }
  scene = s; sceneName = name;
  $('start').classList.add('hidden');
  $('scene-ui').classList.remove('hidden');
  $('info').textContent = s.info;
  idleT = 0;
  scene.start();
  window.wtl = Object.assign(scene.testAPI ? scene.testAPI() : {}, {
    scene: name,
    get view() { return view; },
    canvas,
    pause(on = true) { paused = on; on ? audio.suspend() : audio.resume(); },
    get idle() { return { idleT: +idleT.toFixed(2), after: IDLE_AFTER, ...(scene.idleState ? scene.idleState() : {}) }; },
  });
}

function route() {
  const name = location.hash.replace('#', '');
  if (SCENES[name]) enterScene(name);
  else showMenu();
}
window.addEventListener('hashchange', route);

// a click on a menu entry is the user gesture that unlocks sound
document.querySelectorAll('#menu a').forEach(a => {
  a.addEventListener('click', ensureAudio);
  const img = a.querySelector('img');
  const still = img.src, anim = img.dataset.anim;
  a.addEventListener('mouseenter', () => { img.src = anim; });
  a.addEventListener('mouseleave', () => { img.src = still; });
  a.addEventListener('focus', () => { img.src = anim; });
  a.addEventListener('blur', () => { img.src = still; });
});

// ---------------------------------------------------------------- input → scene

canvas.addEventListener('pointerdown', ev => {
  if (!scene || !scene.running) return;
  const p = env.toStage(ev);
  if (scene.pointerdown(p, ev)) canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', ev => { if (scene && scene.running) scene.pointermove(env.toStage(ev), ev); });
canvas.addEventListener('pointerup', ev => { if (scene && scene.running) scene.pointerup(env.toStage(ev), ev); });
canvas.addEventListener('pointercancel', ev => { if (scene && scene.running) scene.pointerup(env.toStage(ev), ev); });

$('reset').addEventListener('click', () => { if (scene) { scene.reset(); idleT = 0; } });
window.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && sceneName) { location.hash = ''; return; }
  if (!scene) return;
  if (ev.key === 'd') debug = !debug;
  if (ev.key === 'r') { scene.reset(); idleT = 0; }
  if (scene.keydown) scene.keydown(ev);
});
// the audio clock drives the picture: pause it with the tab so both stay locked
document.addEventListener('visibilitychange', () => {
  if (!audio || paused) return;
  if (document.hidden) { audio.suspend(); if (scene && scene.suspend) scene.suspend(true); }
  else { audio.resume(); if (scene && scene.suspend) scene.suspend(false); }
});

requestAnimationFrame(frame);
route();
