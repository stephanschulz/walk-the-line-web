// parität 360: five clips of the same 20-track movie — a person crossing a
// square, filmed from 10 camera positions, each in two walking directions
// (track pairs 1/2, 3/4 … 19/20).  Clicking the left or right half of a clip
// switches it to the neighbouring camera position; if that view shows the
// person walking the other way, the whole chain turns around.
//
// This is a straight port of pari360.dir.  Times are Director ticks (1/60 s);
// the tables say, per track, when the person appears ("in") and leaves ("out").

import { makeHold, drawTile, drawRest } from './videoclip.js';

const TICK = 1 / 60;
// eintritt / austritt per track 1..20 (index 0 unused)
const IN = [0, 257, 400, 248, 320, 276, 208, 190, 412, 416, 424, 424, 256, 264, 0, 220, 0, 404, 128, 391, 391];
const OUT = [0, 764, 868, 811, 1016, 880, 1016, 732, 920, 756, 732, 888, 752, 1030, 784, 1030, 912, 973, 748, 748, 744];
const N = 5;

const wrapTrack = t => ((t - 1) % 20 + 20) % 20 + 1;          // keep 1..20, parity preserved
const pairOf = t => wrapTrack(t % 2 === 0 ? t - 1 : t + 1);   // same camera, other direction
// walking direction of a track (Lingo trackSET): +1 = the chain goes right
const dirOf = t => ((t > 14 || t < 5) ? (t % 2 === 0 ? 1 : -1) : (t % 2 === 0 ? -1 : 1));

export function paritaetScene(cfg) {
  let env, CW, CH, movie, duration, endImg;
  const clips = [];          // { v, T, playing }
  let richtung = 1;          // direction the chain travels
  let autoWait = 0;

  const left = i => cfg.rowLeft + i * CW;

  // ------------------------------------------------------------ clip control
  function start(i, ticks) {
    const c = clips[i];
    c.v.currentTime = ticks * TICK;
    c.v.play().catch(() => {});
    c.playing = true;
  }
  function stop(i) {
    const c = clips[i];
    c.v.pause();
    c.v.currentTime = 0;
    c.playing = false;
  }
  const ticks = i => clips[i].v.currentTime / TICK;

  // the person leaves clip n: start the neighbour in the travel direction
  function handOn(n, dir) {
    const m = (n + dir + N) % N;
    if (clips[m].playing) return;
    if (dirOf(clips[n].T) !== dir) return;
    // the neighbour shows the other walking direction: use its pair track instead
    if (dirOf(clips[m].T) !== dir) clips[m].T = pairOf(clips[m].T);
    start(m, IN[clips[m].T]);
  }

  function update(dt) {
    for (let n = 0; n < N; n++) {                   // movies at their end go back to the start
      const c = clips[n];
      if (c.playing && (c.v.ended || c.v.currentTime >= duration - 0.02)) stop(n);
    }
    for (let n = 0; n < N; n++) {
      if (!clips[n].playing) continue;
      if (ticks(n) > OUT[clips[n].T]) handOn(n, richtung);
    }
    idle(dt);
  }

  // click: right half -> previous camera (T-2), left half -> next camera (T+2)
  function click(i, rightHalf) {
    const c = clips[i];
    c.T = wrapTrack(c.T + (rightHalf ? -2 : 2));
    if (c.playing) richtung = dirOf(c.T);
  }

  // idle: now and then change a perspective, mostly on the clip in play
  function idle(dt) {
    if (!env.idle) { autoWait = rand(1, 3); return; }
    if ((autoWait -= dt) > 0) return;
    autoWait = rand(3, 7);
    const playing = clips.map((c, i) => (c.playing ? i : -1)).filter(i => i >= 0);
    const i = playing.length && Math.random() < 0.6 ? playing[0] : Math.floor(Math.random() * N);
    click(i, Math.random() < 0.5);
  }
  const rand = (a, b) => a + Math.random() * (b - a);

  // ------------------------------------------------------------ drawing / input
  function draw(ctx) {
    // the last good frame is drawn while a seek is in flight (no flicker at a clip's start)
    // a clip at rest shows its first frame from an image, not from a paused, rewound video
    clips.forEach((c, i) => {
      const tile = movie.tiles[String(c.T)];
      if (!c.playing && endImg) drawRest(ctx, endImg, tile, left(i), 0, CW, CH);
      else drawTile(ctx, c.v, c.hold, tile, left(i), 0, CW, CH);
    });
    if (env.debug) {
      ctx.font = '7px monospace';
      clips.forEach((c, i) => {
        ctx.fillStyle = c.playing ? '#ff0' : '#888';
        ctx.fillText(`T${c.T} ${dirOf(c.T) > 0 ? '→' : '←'} ${Math.round(ticks(i))}/${IN[c.T]}-${OUT[c.T]}`, left(i) + 3, 9);
      });
      ctx.fillText(`richtung ${richtung}`, 3, CH + 10);
    }
  }

  const clipAt = p => (p.y < 0 || p.y > CH ? -1 : Math.floor((p.x - cfg.rowLeft) / CW));

  const api = {
    info: cfg.info,
    running: false,
    async load(e, progress) {
      env = e; CW = env.CW; CH = env.CH;
      const data = await env.loadJSON(cfg.url);
      movie = data.movie;
      duration = movie.duration;
      endImg = await env.loadImage(movie.start);      // rewound clips rest on frame 0 (as in the original)
      let done = 0;
      const vids = await Promise.all(Array.from({ length: N }, () =>
        env.createVideo(movie.video).then(v => { progress(++done, N); return v; })));
      vids.forEach(v => clips.push({ v, T: 20, playing: false, hold: makeHold(CW, CH) }));
    },
    reset() {
      clips.forEach((c, i) => { stop(i); c.T = 20; });
      richtung = 1;
      start(0, IN[20]);
    },
    start() { api.reset(); api.running = true; },
    update,
    draw,
    pointerdown(p) {
      const i = clipAt(p);
      if (i < 0 || i >= N) return false;
      env.userActed();
      click(i, p.x > left(i) + CW / 2);
      return false;
    },
    pointermove(p) { const i = clipAt(p); env.setCursor(i >= 0 && i < N ? 'click' : null); },
    pointerup() {},
    suspend(on) { clips.forEach(c => { if (c.playing) on ? c.v.pause() : c.v.play().catch(() => {}); }); },
    destroy() { api.running = false; clips.forEach(c => { c.v.pause(); c.v.remove(); }); },
    testAPI() {
      return {
        get clips() { return clips.map((c, i) => ({ T: c.T, dir: dirOf(c.T), t: +ticks(i).toFixed(0), playing: c.playing })); },
        get richtung() { return richtung; },
        click,
      };
    },
  };
  return api;
}
