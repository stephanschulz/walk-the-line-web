// Seam film strip: a test aid for the hand-off between two clips in the drag
// scenes (fussball, stadt, ton).  Load it in the running page, then e.g.
//   const s = await seamStrip({ seam: 1, gaps: [200, 100, 200, 200], dir: 'fwd' });
//   document.body.append(s)
// seam k = the edge where clip k+1 starts covering clip k.  The strip shows
// `before` frames before the receiving clip starts and `after` frames after,
// stepped at `dt`, each cropped to +-`half` stage px around the seam (marked
// yellow before / green after the hand-off).  dir 'back' only exists in fussball.
window.seamStrip = async ({ seam, gaps, dir = 'fwd', before = 5, after = 7, dt = 1 / 30, half = 60 }) => {
  wtl.pause(); wtl.reset(); wtl.setGaps(gaps);
  const recv = dir === 'fwd' ? seam + 1 : seam;
  const send = dir === 'fwd' ? seam : seam + 1;
  const v = wtl.view, c = wtl.canvas, k = v.dpr * v.scale;
  const seamX = wtl.lefts[seam + 1];
  const sx = (v.x0 + (seamX - half) * v.scale) * v.dpr, sy = v.y0 * v.dpr;
  const w = Math.round(2 * half * k), h = Math.round(150 * k);
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const grab = () => { const t = document.createElement('canvas'); t.width = w; t.height = h; t.getContext('2d').drawImage(c, sx, sy, w, h, 0, 0, w, h); return t; };
  const isOn = i => wtl.clips[i].playing && wtl.clips[i].track === dir;
  // fast-forward until the sending clip carries the traveller, and the receiver is idle
  let n = 0;
  while (!(isOn(send) && !isOn(recv)) && n++ < 40000) wtl.step(1 / 240);
  // step at dt, keeping the last `before` crops, until the receiving clip starts
  const ring = [];
  while (!isOn(recv) && n++ < 40000) {
    await frame(); ring.push(grab()); if (ring.length > before) ring.shift();
    wtl.step(dt);
  }
  const shots = ring.slice();
  for (let i = 0; i < after; i++) { await frame(); shots.push(grab()); wtl.step(dt); }
  const strip = document.createElement('canvas');
  strip.width = w; strip.height = h * shots.length;
  const g = strip.getContext('2d');
  shots.forEach((s, i) => {
    g.drawImage(s, 0, i * h);
    g.fillStyle = i < ring.length ? '#ff0' : '#0f0';
    g.fillRect(w / 2 - 1, i * h, 2, 8);
  });
  return strip;
};
