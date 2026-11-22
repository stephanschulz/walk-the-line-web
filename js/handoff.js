// Drag scenes: fussball, stadt, ton.
//
// Clips sit side by side, each `gap` px to the right of its left neighbour
// (200 = touching, smaller = overlapping).  Dragging clip k left lowers gap[k]:
// it covers the right part of clip k-1, and every clip to its right follows.
//
// Something travels through the row (a ball, a runner, walkers).  Each clip
// knows when it crosses any x (its "in" and "out" passes, see tools/extract*.py).
// When it reaches the edge where the next clip begins to cover it, the next
// clip is started at the moment its own traveller is at that same screen
// position — so the motion looks continuous no matter how the clips overlap.
//
// mode 'pingpong' (fussball): the ball goes right, is kicked back at the right
//   end (each clip has a 'fwd' and a 'back' track) and kicked right again at
//   the left end.
// mode 'chain' (stadt, ton): one direction only.  When the walker leaves the
//   last clip, or reaches the right edge of the 1024 px stage (stadt's row is
//   wider than the stage), clip 1 starts again.  A clip that the walker has
//   left goes back to its first frame.  Double-click a clip and click another
//   to swap them.  ton: each film owns one layer of a soundtrack, which
//   switches whenever the next walker starts.

const MIN_GAP = 4;            // px a clip always keeps visible of its left neighbour
const AUTO_SPEED = 18;        // idle hand: scene px per second
const AUTO_MIN_GAP = 30;      // the idle hand never hides a clip almost completely
const RIGHT = 1, LEFT = -1;
const DOUBLE_CLICK = 0.4;     // s

const smooth = u => u * u * (3 - 2 * u);
const rand = (a, b) => a + Math.random() * (b - a);

// Time (s) at which the traveller of a pass is at clip-x `x`.  Outside the
// pass's x range the nearest end is used (e.g. a ball lying still before a kick).
function timeAtX(pass, fps, x) {
  const p = pass.path;
  const xs = p.map(q => q[1]);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  x = Math.min(hi, Math.max(lo, x));
  for (let k = 0; k < p.length - 1; k++) {
    const [fa, xa] = p[k], [fb, xb] = p[k + 1];
    if ((x - xa) * (x - xb) <= 0) {
      const u = xb === xa ? 0 : (x - xa) / (xb - xa);
      return (fa + u * (fb - fa)) / fps;
    }
  }
  return p[p.length - 1][0] / fps;
}

export function handoffScene(cfg) {
  let env, CW, CH, COLS, STAGE_W;
  let films = [];             // per film: { id, tracks: {name: track}, still, layer }
  let slot = [];              // slot[i] = index into films shown at position i
  let clips = [];             // runtime state per position
  let gaps = [];              // gaps[i] = left[i] - left[i-1]   (gaps[0] unused)
  let drag = null;            // { k, grabDx, moved }
  let auto = null;            // idle hand: { k, from, to, t, dur } or { wait }
  let selected = -1;          // swap: position picked up by a double-click
  let lastUp = { t: -1, k: -1 };
  let clock = 0;              // scene time, for double-click detection
  let layerSrc = null;        // ton: the soundtrack layer playing now
  let mouse = null;

  const n = () => clips.length;
  // cfg.filler: a black frame after the last clip (as in the original ton score),
  // so the last clip can be covered too.  It is position n() in the row.
  const count = () => clips.length + (cfg.filler ? 1 : 0);
  const film = i => films[slot[i]];
  const track = i => film(i).tracks[clips[i].track];

  // ------------------------------------------------------------ layout
  const lefts = () => {
    const l = [cfg.rowLeft];
    for (let i = 1; i < count(); i++) l.push(l[i - 1] + gaps[i]);
    return l;
  };
  const visibleWidth = i => (i < count() - 1 ? gaps[i + 1] : CW);

  // ------------------------------------------------------------ audio
  function stopAudio(c) { if (c.src) { c.src.stop(); c.src = null; } }

  function startClip(i, trackName, t0) {
    const c = clips[i];
    const tr = film(i).tracks[trackName];
    c.track = trackName;
    // t may start slightly below 0 when the traveller enters "before" the first
    // frame: the clip then holds frame 0 and its sound starts a moment later
    c.t = Math.max(-0.5, Math.min(t0, tr.duration));
    c.playing = c.t < tr.duration;
    c.started = true;
    c.outFired = false;
    stopAudio(c);
    if (c.playing && tr.buffer) c.src = env.play(tr.buffer, { offset: Math.max(0, c.t), delay: -c.t });
    if (cfg.layers && film(i).layerBuffer) {        // ton: this walker's soundtrack layer
      if (layerSrc) layerSrc.stop();
      layerSrc = env.play(film(i).layerBuffer, { loop: true });
    }
  }

  function stopClip(i) {
    const c = clips[i];
    stopAudio(c);
    Object.assign(c, { t: 0, playing: false, started: false, outFired: false });
  }

  // ------------------------------------------------------------ update
  function update(dt) {
    clock += dt;
    idleHand(dt);
    const ended = [];
    clips.forEach((c, i) => {
      if (!c.playing) return;
      const tr = track(i);
      c.t += dt;
      if (c.t >= tr.duration) { ended.push([i, c.t - tr.duration]); c.t = tr.duration; c.playing = false; }
    });
    if (cfg.mode === 'pingpong') pingpong(ended);
    else chain(ended);
  }

  // fussball: hand the ball to the neighbour in the direction it travels
  function pingpong(ended) {
    clips.forEach((c, i) => {
      const tr = track(i);
      if (c.outFired || !tr.out || !c.started) return;
      const dir = tr.out.dir, j = i + dir;
      if (j < 0 || j >= n()) return;
      // where the ball leaves clip i: under clip i+1's left edge, or clip i's own left edge
      const edge = dir === RIGHT ? visibleWidth(i) : 0;
      const tEdge = timeAtX(tr.out, tr.fps, edge);
      if (c.t < tEdge) return;
      c.outFired = true;
      const nextName = dir === RIGHT ? 'fwd' : 'back';
      const next = film(j).tracks[nextName];
      // where the ball appears in clip j: its left edge, or the right edge of its visible part
      const entry = dir === RIGHT ? 0 : visibleWidth(j);
      startClip(j, nextName, timeAtX(next.in, next.fps, entry) + (c.t - tEdge));
    });
    // a track that continues into another one on the same clip (rechts: stop -> kick back)
    for (const [i, over] of ended) {
      const then = track(i).then;
      if (then) startClip(i, then, over);
    }
  }

  // where the walker of clip i leaves the visible picture, and which clip takes over
  function exitOf(i) {
    const l = lefts();
    const vis = visibleWidth(i);
    const onStage = STAGE_W - l[i];                 // part of clip i left of the stage edge
    if (onStage <= vis) return { edge: Math.max(0, onStage), next: 0 };   // stage edge: wrap
    if (i === n() - 1) return { edge: vis, next: 0 };                     // end of the row: wrap
    return { edge: vis, next: i + 1 };
  }

  // stadt / ton
  function chain(ended) {
    const justEnded = new Map(ended);              // clip -> seconds run past its end this frame
    clips.forEach((c, i) => {
      if (!c.playing && !justEnded.has(i)) return;
      const tr = track(i);
      const { edge, next } = exitOf(i);
      const tEdge = timeAtX(tr.out, tr.fps, edge);
      const now = c.t + (justEnded.get(i) || 0);
      // hand on when the walker reaches the edge — or when the clip ends first
      // (ton 'head': its walker reaches x=200 a frame after the last one)
      if (!c.outFired && (now >= tEdge || justEnded.has(i))) {
        c.outFired = true;
        // as in the Lingo: only a clip that isn't playing is started
        if (!clips[next].playing && next !== i) {
          const nt = film(next).tracks.fwd;
          startClip(next, 'fwd', timeAtX(nt.in, nt.fps, 0) + (now - tEdge));
        }
      }
      // played to the end, or the walker has left the visible part: rewind (Lingo: movietime = 0)
      if (justEnded.has(i) || (c.outFired && c.t >= timeAtX(tr.out, tr.fps, edge + cfg.resetAfter))) stopClip(i);
    });
  }

  // ------------------------------------------------------------ idle hand
  function nextAutoMove() {
    // pick a clip (not the leftmost) and a new overlap that is visibly different;
    // now and then open a clip fully again so the row doesn't stay crumpled
    const k = 1 + Math.floor(Math.random() * (count() - 1));
    const from = gaps[k];
    let to;
    if (Math.random() < 0.25 && from < CW - 30) to = CW;
    else { do { to = Math.round(rand(AUTO_MIN_GAP, CW)); } while (Math.abs(to - from) < 30); }
    return { k, from, to, t: 0, dur: Math.max(2, Math.abs(to - from) / AUTO_SPEED) };
  }

  function idleHand(dt) {
    if (drag || !env.idle) { auto = null; return; }
    if (!auto) auto = nextAutoMove();
    if (auto.wait !== undefined) {
      if ((auto.wait -= dt) <= 0) auto = nextAutoMove();
      return;
    }
    auto.t = Math.min(auto.dur, auto.t + dt);
    gaps[auto.k] = auto.from + (auto.to - auto.from) * smooth(auto.t / auto.dur);
    if (auto.t >= auto.dur) auto = { wait: rand(1.5, 4) };
  }

  // ------------------------------------------------------------ drawing
  function draw(ctx) {
    const l = lefts();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, STAGE_W, CH);                    // the Director stage: beyond it nothing shows
    ctx.clip();
    // left to right: each clip is painted over its left neighbour, which crops it
    clips.forEach((c, i) => {
      if (l[i] >= STAGE_W) return;
      const f = film(i);
      // a resting clip (stadt, ton) shows its empty place: its first frame may
      // already show the walker entering at the left edge
      if (f.stillImg && (i === selected || (cfg.mode === 'chain' && !c.started))) {
        ctx.drawImage(f.stillImg, l[i], 0, CW, CH);
        return;
      }
      const tr = track(i);
      // nearest frame, not the previous one: frame k shows the traveller at k/fps,
      // so rounding keeps 15 fps and 25 fps clips in phase at a seam
      const fr = Math.max(0, Math.min(tr.frames - 1, Math.round(c.t * tr.fps)));
      ctx.drawImage(tr.img, (fr % COLS) * CW, Math.floor(fr / COLS) * CH, CW, CH, l[i], 0, CW, CH);
    });
    if (cfg.filler) {                               // the black frame: black, with a faint edge to grab
      const x = l[n()];
      ctx.fillStyle = '#000';
      ctx.fillRect(x, 0, CW, CH);
      ctx.fillStyle = 'rgba(255,255,255,.12)';
      ctx.fillRect(x, 0, 1 / env.view.scale, CH);
    }
    if (selected >= 0) {                            // the picked-up clip, waiting for its swap partner
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 2 / env.view.scale;
      ctx.strokeRect(l[selected] + 1, 1, visibleWidth(selected) - 2, CH - 2);
      if (mouse) {
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.fillRect(mouse.x - 1, -10, 2, 6);
        ctx.fillRect(mouse.x - 1, CH + 4, 2, 6);
      }
    }
    if (env.debug) drawDebug(ctx, l);
    ctx.restore();
  }

  function drawDebug(ctx, l) {
    ctx.font = '7px monospace';
    ctx.lineWidth = 1 / env.view.scale;
    clips.forEach((c, i) => {
      const tr = track(i);
      ctx.strokeStyle = 'rgba(255,255,0,.8)';
      ctx.strokeRect(l[i], 0, visibleWidth(i), CH);
      ctx.fillStyle = c.playing ? '#ff0' : '#888';
      ctx.fillText(`${film(i).id} ${c.track} ${c.t.toFixed(2)}/${tr.duration.toFixed(2)}`, l[i] + 3, 9);
      ctx.fillText(`w ${Math.round(visibleWidth(i))}${c.outFired ? ' out' : ''}`, l[i] + 3, 18);
      for (const key of ['in', 'out']) {
        if (!tr[key]) continue;
        ctx.fillStyle = key === 'in' ? '#0f0' : '#f0f';
        for (const [, x] of tr[key].path) ctx.fillRect(l[i] + x - 1, CH - 6 - (key === 'out' ? 4 : 0), 2, 2);
      }
    });
  }

  // ------------------------------------------------------------ input
  function clipAt(p) {
    if (p.y < 0 || p.y > CH || p.x < 0) return -1;
    const l = lefts();
    if (cfg.filler && p.x >= l[n()] && p.x < l[n()] + CW) return n();
    if (p.x > STAGE_W) return -1;
    for (let i = n() - 1; i >= 0; i--) if (p.x >= l[i] && p.x < l[i] + CW) return i;
    return -1;
  }

  function pointerdown(p) {
    const k = clipAt(p);
    if (k < 0) { selected = -1; return false; }
    env.userActed();
    // swap: a clip was picked up by a double-click; this click names its partner
    if (cfg.swap && selected >= 0 && k !== selected && k < n() && !clips[k].playing) {
      [slot[selected], slot[k]] = [slot[k], slot[selected]];
      stopClip(selected); stopClip(k);
      selected = -1;
    }
    if (k < 1) return false;                         // the leftmost clip has nothing to cover
    drag = { k, grabDx: p.x - lefts()[k], moved: false, x0: p.x };
    auto = null;
    env.setCursor('grabbing');
    return true;
  }

  function pointermove(p) {
    mouse = p;
    if (!drag) { env.setCursor(clipAt(p) >= 1 ? 'grab' : null); return; }
    if (Math.abs(p.x - drag.x0) > 2) drag.moved = true;
    const l = lefts();
    const want = p.x - drag.grabDx - l[drag.k - 1];
    gaps[drag.k] = Math.round(Math.max(MIN_GAP, Math.min(CW, want)));
  }

  function pointerup(p) {
    const k = clipAt(p);
    if (drag) env.userActed();
    const clicked = !drag || !drag.moved;
    drag = null;
    env.setCursor(k >= 1 ? 'grab' : null);
    // double-click on a clip that isn't playing picks it up for a swap
    if (cfg.swap && clicked && k >= 0 && k < n()) {
      if (lastUp.k === k && clock - lastUp.t < DOUBLE_CLICK && !clips[k].playing) { selected = k; lastUp = { t: -1, k: -1 }; }
      else lastUp = { t: clock, k };
    }
  }

  // ------------------------------------------------------------ lifecycle
  async function load(e, progress) {
    env = e; CW = env.CW; CH = env.CH; STAGE_W = env.STAGE_W;
    const data = await env.loadJSON(cfg.url);
    COLS = data.cols;
    if (cfg.mode === 'pingpong') {
      films = data.clips.map(c => ({ id: c.id, tracks: c.tracks }));
    } else {                                         // chain: one track, the walker's pass is both in and out
      films = data.clips.map(c => ({
        id: c.id, still: c.still, layer: c.layer,
        tracks: { fwd: { image: c.image, audio: c.audio, fps: c.fps, frames: c.frames,
          in: { dir: RIGHT, path: c.path }, out: { dir: RIGHT, path: c.path } } },
      }));
    }
    const jobs = [];
    for (const f of films) {
      for (const tr of Object.values(f.tracks)) {
        tr.duration = tr.frames / tr.fps;
        jobs.push(env.loadImage(tr.image).then(img => { tr.img = img; }));
        if (tr.audio) jobs.push(env.loadAudio(tr.audio).then(b => { tr.buffer = b; }));
      }
      if (f.still) jobs.push(env.loadImage(f.still).then(img => { f.stillImg = img; }));
      if (f.layer && cfg.layers) jobs.push(env.loadAudio(f.layer).then(b => { f.layerBuffer = b; }));
    }
    let done = 0;
    jobs.forEach(j => j.then(() => progress(++done, jobs.length)));
    await Promise.all(jobs);
  }

  function reset() {
    clips.forEach(stopAudio);
    if (layerSrc) { layerSrc.stop(); layerSrc = null; }
    slot = films.map((_, i) => i);
    clips = films.map(() => ({ track: 'fwd', t: 0, playing: false, started: false, outFired: false, src: null }));
    gaps = Array.from({ length: count() }, () => CW);
    selected = -1; auto = null; drag = null;
    startClip(0, 'fwd', cfg.startAt || 0);
  }

  const api = {
    info: cfg.info,
    running: false,
    load,
    start() { reset(); api.running = true; },
    reset,
    update,
    draw,
    pointerdown, pointermove, pointerup,
    keydown(ev) { if (ev.key === 'Escape') selected = -1; },
    destroy() {
      api.running = false;
      clips.forEach(stopAudio);
      if (layerSrc) layerSrc.stop();
    },
    idleState() { return { auto }; },
    testAPI() {
      return {
        get clips() { return clips.map((c, i) => ({ id: film(i).id, track: c.track, t: +c.t.toFixed(3), playing: c.playing, out: c.outFired })); },
        get gaps() { return gaps.slice(1); },
        get lefts() { return lefts(); },
        get slot() { return slot.map(s => films[s].id); },
        setGaps(g) { g.forEach((v, i) => { gaps[i + 1] = Math.max(MIN_GAP, Math.min(CW, v)); }); },
        swap(a, b) { [slot[a], slot[b]] = [slot[b], slot[a]]; stopClip(a); stopClip(b); },
        reset,
        step(dt) { update(dt); },
      };
    },
  };
  return api;
}
