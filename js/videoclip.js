// The multi-track scenes (parität, ritter) show their mosaic videos as real,
// visible <video> elements, each cropped by CSS to the tile of its current
// track — not copied onto the canvas.  Safari only decodes and paints a video
// reliably while it is actually on screen; copying frames from hidden videos
// froze there after a few frames.  Switching the track only moves the crop,
// so it stays instant.
//
// Every clip also has a still image (the first or last frame of all tracks,
// same mosaic layout) on top of the video.  It shows while the clip rests, and
// while its video is still seeking — so a stale picture never shows.

// one row of clips on the 1024 px stage, positioned like the canvas stage
export function domRow(count, rowLeft, CW, CH) {
  const root = document.createElement('div');
  root.className = 'dom-row';
  const cells = [];
  for (let i = 0; i < count; i++) {
    const d = document.createElement('div');
    d.className = 'dom-clip';
    d.style.left = `${rowLeft + i * CW}px`;
    d.style.width = `${CW}px`;
    d.style.height = `${CH}px`;
    root.append(d);
    cells.push(d);
  }
  // diagnostics (key D): the state of every video, as text under the row
  const info = document.createElement('pre');
  info.className = 'dom-debug';
  root.append(info);
  document.body.append(root);
  let last = '';
  return {
    cells,
    debug(lines) {
      info.style.display = lines ? 'block' : 'none';
      if (lines) info.textContent = lines.join('\n');
    },
    // follow the canvas stage (resize, zoom)
    sync(view) {
      const t = `translate(${view.x0}px, ${view.y0}px) scale(${view.scale})`;
      if (t !== last) { root.style.transform = t; last = t; }
    },
    remove() { root.remove(); },
  };
}

// a video + its rest image inside one cell
export function domClip(cell, video, restImg) {
  const img = restImg.cloneNode();
  for (const el of [video, img]) {
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.maxWidth = 'none';
  }
  video.style.width = `${video.videoWidth}px`;
  video.style.height = `${video.videoHeight}px`;
  img.style.width = `${restImg.naturalWidth}px`;
  img.style.height = `${restImg.naturalHeight}px`;
  cell.append(video, img);
  let tileKey = '', resting = null, waking = true;
  let lastT = -1, stalls = 0, frames = 0;
  return {
    // one line of diagnostics: is the video really advancing while it should play?
    status(label, shouldPlay) {
      const t = video.currentTime;
      if (shouldPlay && !video.paused) { if (t === lastT) stalls++; frames++; }
      lastT = t;
      const buf = video.buffered.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : '0';
      return `${label.padEnd(16)} t ${t.toFixed(2).padStart(5)}  ${video.paused ? 'paused ' : 'playing'}` +
        `  ready ${video.readyState}  net ${video.networkState}${video.seeking ? '  SEEKING' : ''}` +
        `  rate ${video.playbackRate}  buf ${buf}/${video.duration.toFixed(1)}` +
        `  stalled ${stalls}/${frames}${resting ? '  [image]' : ''}${video.error ? '  ERROR ' + video.error.code : ''}`;
    },
    // show `tile` ([x, y] in the mosaic); `rest` = show the still image
    set(tile, rest) {
      const key = tile.join(',');
      if (key !== tileKey) {
        const tr = `translate(${-tile[0]}px, ${-tile[1]}px)`;
        video.style.transform = tr;
        img.style.transform = tr;
        tileKey = key;
      }
      // a clip starting from rest keeps its image until the seek to its start
      // time has landed; a jump within a playing clip (ritter's waiting loop)
      // keeps showing the video, so nothing flashes there
      const ready = !video.seeking && video.readyState >= 2;
      if (rest) waking = true;
      else if (ready) waking = false;
      const r = rest || waking;
      if (r !== resting) { img.style.visibility = r ? 'visible' : 'hidden'; resting = r; }
    },
  };
}
