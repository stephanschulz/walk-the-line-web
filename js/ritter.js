// ritter: two knights on hobby horses.  The white knight waits in the left
// clip, the red knight in the right one.  The first click on one of the three
// middle clips decides where they meet — exchange (tausch), handshake (hand)
// or fight (kampf); every click on a middle clip changes its time of day.
// The knights then ride through the clips in between, meet with sound, and
// go back to waiting.  The 'cash' ambience is muted during the meeting.
//
// Based on ritterR.dir: same sprites (S(1) = white knight … S(5) = red knight),
// same tracks (middle movies: 2-4 meeting, 5-7 a knight riding through — in
// hand 5-7 red, 8-10 white — each in three times of day), same rates (the red
// knight rides at 1.1), same click logic.  The timing is new: the Lingo
// started the next clip at fixed tick offsets that were tuned around
// QuickTime's start-up lag, so the knights jumped or vanished between clips.
// Here the hand-offs use the measured moments at which a rider's front reaches
// a clip edge (tools/measure_riders.py): the next clip starts exactly when the
// rider would appear in it, and each knight's departure is timed so that both
// arrive in the meeting clip when the meeting footage expects them.

import { makeHold, drawTile } from './videoclip.js';

const TICK = 1 / 60;
const NAMES = ['weiss', 'tausch', 'hand', 'kampf', 'rot'];
const WAIT_LOOP = 350 * TICK;        // the waiting knights loop up to here (sitting); riding starts here
// route of each knight to the meeting place M (sprite numbers)
const ROUTES = {
  2: { w: [1, 2], r: [5, 4, 3, 2] },
  3: { w: [1, 2, 3], r: [5, 4, 3] },
  4: { w: [1, 2, 3, 4], r: [5, 4] },
};
// the white knight rides to the right (enters a clip on its left edge), the red one to the left
const SIDE = { w: { in: 'L', out: 'R' }, r: { in: 'R', out: 'L' } };

export function ritterScene(cfg) {
  let env, CW, CH, data;
  const S = [];               // S[1..5]: { v, movie, track, playing, parked, rate, audioOn, src, parkAt }
  let cash = null, cashBuffer = null;
  let wer, wahl;              // Lingo: meeting place, "already chosen"
  const klick = [0, 0, 2, 2, 2, 0], treff = [0, 0, 4, 4, 4, 0];
  const clickT = [0, 0, 0, 0, 0, 0];               // per-sprite property t (survives a new round)
  let knights = null;         // during a ride: { w: {...}, r: {...} }
  let clock = 0;
  let autoWait = 0;

  const left = n => cfg.rowLeft + (n - 1) * CW;
  const T = n => (S[n].parked ? 0 : S[n].v.currentTime);       // seconds of movie time

  // ------------------------------------------------------------ measured edges
  // first interval [front touches, back clears] at `side` of sprite n's track, after `after` s
  function edge(n, track, side, after = 0) {
    const e = S[n].movie.edges[String(track)];
    const iv = e && e[side].find(([a]) => a >= after);
    return iv || [0, 0];
  }
  const entryOf = (n, track, k) => edge(n, track, SIDE[k].in)[0];
  const exitOf = (n, track, k) => edge(n, track, SIDE[k].out, n === 1 || n === 5 ? WAIT_LOOP : 0);
  // red rides at 1.1 in his own clip and through kampf (Lingo); meetings play at 1
  const rateOf = (n, k) => (k === 'r' && (n === 5 || (n === 4 && wer !== 4)) ? 1.1 : 1);
  const levelOf = n => treff[n] + klick[n];

  // ------------------------------------------------------------ sprite control
  function startAt(n, sec, rate = 1) {
    const s = S[n];
    s.parked = false;
    s.v.currentTime = Math.max(0, sec);
    s.rate = rate;
    s.v.playbackRate = rate;
    s.playing = true;
    s.parkAt = Infinity;
    s.v.play().catch(() => {});
    if (s.src) { s.src.stop(); s.src = null; }
    if (s.audioOn && s.buffer) s.src = env.play(s.buffer, { offset: Math.max(0, sec), rate });
  }
  // The Lingo rewinds a clip as soon as a knight has ridden out of it, which
  // brings him back on screen (frame 0).  Here such a clip is "parked" on its
  // last frame — the empty place; a new round (keep = false) rewinds for real.
  function stop(n, keep = true) {
    const s = S[n];
    s.v.pause();
    if (keep && s.playing) { s.parked = true; s.v.currentTime = Math.max(0, s.movie.duration - 0.05); }
    else { s.parked = false; s.v.currentTime = 0; }
    s.playing = false;
    if (s.src) { s.src.stop(); s.src = null; }
  }
  function cashOn(on) { if (cash) cash.setGain(on ? 1 : 0, 0.3); }
  function setzen() { for (let n = 2; n <= 4; n++) S[n].track = levelOf(n); }

  // ------------------------------------------------------------ a round
  function startmovie() {                          // back to waiting
    klick.splice(0, 6, 0, 0, 2, 2, 2, 0);
    treff.splice(0, 6, 0, 0, 4, 4, 4, 0);
    for (let n = 1; n <= 5; n++) { stop(n, false); S[n].audioOn = false; }
    cashOn(true);
    startAt(1, 0, 1);
    startAt(5, 0, 1.1);
    wahl = 0; wer = 0; knights = null;
    setzen();
  }

  // the meeting place is chosen: plan both rides
  function plan(M) {
    treff[2] = treff[3] = treff[4] = 4;
    if (M === 4) treff[3] = 7;                     // hand: the white knight rides through (tracks 8-10)
    setzen();
    const meetTrack = 1 + klick[M];                // the meeting tracks share their timing
    const ks = {};
    for (const k of ['w', 'r']) {
      const route = ROUTES[M][k];
      // wall time from departure until the knight's front reaches the meeting clip
      let ride = 0;
      route.slice(0, -1).forEach((n, i) => {
        const tr = S[n].track;
        const from = i === 0 ? WAIT_LOOP : entryOf(n, tr, k);
        ride += (exitOf(n, tr, k)[0] - from) / rateOf(n, k);
      });
      ks[k] = { route, idx: 0, ride, meetEntry: entryOf(M, meetTrack, k), departed: false };
    }
    // both must reach the meeting clip when its footage shows them arriving
    const lead = { w: ks.w.ride - ks.w.meetEntry, r: ks.r.ride - ks.r.meetEntry };
    const first = Math.max(lead.w, lead.r);
    ks.w.departAt = clock + 0.05 + (first - lead.w);
    ks.r.departAt = clock + 0.05 + (first - lead.r);
    knights = ks;
  }

  function startMeeting(M, sec) {
    treff[M] = 1;
    setzen();
    S[M].audioOn = true;
    startAt(M, sec, 1);
    cashOn(false);
  }

  // ------------------------------------------------------------ every frame
  function update(dt) {
    clock += dt;
    if (wer && !knights) plan(wer);
    for (const k of ['w', 'r']) {
      const n0 = k === 'w' ? 1 : 5;
      const kn = knights && knights[k];
      // not riding yet: sit (loop the first 350 ticks)
      if (!kn || !kn.departed) {
        if (S[n0].playing && T(n0) >= WAIT_LOOP) S[n0].v.currentTime = 2 * TICK;
        if (kn && clock >= kn.departAt) { S[n0].v.currentTime = WAIT_LOOP; kn.departed = true; }
        continue;
      }
      // riding: when his front reaches the edge, the next clip takes over
      const route = kn.route;
      if (kn.idx >= route.length - 1) continue;
      const n = route[kn.idx];
      if (!S[n].playing) continue;
      const tr = S[n].track;
      const [front, clear] = exitOf(n, tr, k);
      if (T(n) < front) continue;
      const late = (T(n) - front) / S[n].rate;       // wall seconds since the front reached the edge
      S[n].parkAt = clear;                           // park once he has fully left
      const m = route[kn.idx + 1];
      kn.idx++;
      if (m === wer) {
        // the meeting clip: the first knight to arrive starts it where the footage has him arriving
        if (!S[m].playing) startMeeting(m, kn.meetEntry + late);
      } else {
        startAt(m, entryOf(m, S[m].track, k) + late * rateOf(m, k), rateOf(m, k));
      }
    }
    for (let n = 1; n <= 5; n++) {                   // park clips the knights have left
      const s = S[n];
      if (!s.playing || n === wer) continue;
      if (T(n) >= s.parkAt || s.v.ended) stop(n);
    }
    if (wer && S[wer].playing && (S[wer].v.ended || T(wer) >= S[wer].movie.duration - 0.03)) startmovie();
    idle(dt);
  }

  // mousedown on a middle clip
  function click(n) {
    if (wahl === 0) { wer = n; wahl = 1; }
    clickT[n] += 1;
    klick[n] = clickT[n];
    setzen();
    if (clickT[n] === 3) clickT[n] = 0;
  }

  // idle: the knights don't wait forever — pick a meeting place for them
  function idle(dt) {
    if (!env.idle || wer !== 0) { autoWait = 2; return; }
    if ((autoWait -= dt) > 0) return;
    click(2 + Math.floor(Math.random() * 3));
  }

  // ------------------------------------------------------------ drawing / input
  function draw(ctx) {
    for (let n = 1; n <= 5; n++) {
      const s = S[n];
      drawTile(ctx, s.v, s.hold, s.movie.tiles[String(s.track)], left(n), 0, CW, CH);
    }
    if (env.debug) {
      ctx.font = '7px monospace';
      for (let n = 1; n <= 5; n++) {
        ctx.fillStyle = S[n].playing ? '#ff0' : '#888';
        ctx.fillText(`${NAMES[n - 1]} tr${S[n].track} ${T(n).toFixed(2)}/${S[n].movie.duration.toFixed(1)}${S[n].src ? ' ♪' : ''}${S[n].parked ? ' P' : ''}`, left(n) + 3, 9);
      }
      ctx.fillStyle = '#ff0';
      ctx.fillText(`wer ${wer}  klick ${klick.slice(2, 5)}  treff ${treff.slice(2, 5)}`, 3, CH + 10);
    }
  }

  const spriteAt = q => (q.y < 0 || q.y > CH ? -1 : 1 + Math.floor((q.x - cfg.rowLeft) / CW));

  const api = {
    info: cfg.info,
    running: false,
    async load(e, progress) {
      env = e; CW = env.CW; CH = env.CH;
      data = await env.loadJSON(cfg.url);
      const jobs = [];
      NAMES.forEach((name, k) => {
        const movie = data.movies[name];
        const s = { movie, track: movie.tiles['1'] ? 1 : 2, playing: false, parked: false, rate: 1, audioOn: false, src: null, parkAt: Infinity,
          hold: makeHold(CW, CH) };
        if (!movie.tiles[String(s.track)]) s.track = Number(Object.keys(movie.tiles)[0]);
        S[k + 1] = s;
        jobs.push(env.createVideo(movie.video).then(v => { s.v = v; }));
        if (movie.audio) jobs.push(env.loadAudio(movie.audio).then(b => { s.buffer = b; }));
      });
      jobs.push(env.loadAudio(data.ambience.audio).then(b => { cashBuffer = b; }));
      let done = 0;
      jobs.forEach(j => j.then(() => progress(++done, jobs.length)));
      await Promise.all(jobs);
    },
    start() {
      cash = env.play(cashBuffer, { loop: true });
      startmovie();
      api.running = true;
    },
    reset() { startmovie(); },
    update,
    draw,
    pointerdown(q) {
      const n = spriteAt(q);
      if (n < 2 || n > 4) return false;
      env.userActed();
      click(n);
      return false;
    },
    pointermove(q) { const n = spriteAt(q); env.setCursor(n >= 2 && n <= 4 ? 'click' : null); },
    pointerup() {},
    suspend(on) { for (let n = 1; n <= 5; n++) if (S[n].playing) on ? S[n].v.pause() : S[n].v.play().catch(() => {}); },
    destroy() {
      api.running = false;
      if (cash) cash.stop();
      for (let n = 1; n <= 5; n++) if (S[n]) { if (S[n].src) S[n].src.stop(); if (S[n].v) { S[n].v.pause(); S[n].v.remove(); } }
    },
    testAPI() {
      return {
        get state() {
          return { wer, klick: klick.slice(2, 5), treff: treff.slice(2, 5),
            knights,
            sprites: [1, 2, 3, 4, 5].map(n => ({ name: NAMES[n - 1], track: S[n].track, t: +T(n).toFixed(3), playing: S[n].playing, parked: S[n].parked, rate: S[n].rate, sound: !!S[n].src })) };
        },
        click,
      };
    },
  };
  return api;
}
