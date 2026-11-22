// Drawing one tile of a mosaic <video> without flicker, and cheaply.
//
// After `currentTime` is set, a video keeps presenting its previous frame (or
// nothing) until the seek has landed, so drawing straight from it flashes the
// old picture.  Every clip therefore keeps its own copy of the last good frame
// and draws that.  The copy is refreshed only when there is something new — a
// new video frame (the movies run at 15 fps) or another tile (perspective /
// time of day) — and never while a seek is in flight.  Copying from a video is
// expensive in Safari, so doing it 15 instead of 60-120 times a second matters.
// `freeze` keeps the copy unchanged on purpose.

const FPS = 15;

export function makeHold(CW, CH) {
  const c = document.createElement('canvas');
  c.width = CW; c.height = CH;
  return { canvas: c, ctx: c.getContext('2d'), valid: false, freeze: false, frame: -1, tile: '' };
}

// a clip at rest shows the empty place from an image (the last frame of its
// track) instead of a paused video: Safari keeps presenting a stale picture
// after a paused video has been moved to another time
export function drawRest(ctx, img, tile, x, y, CW, CH) {
  ctx.drawImage(img, tile[0], tile[1], CW, CH, x, y, CW, CH);
}

export function drawTile(ctx, video, hold, tile, x, y, CW, CH) {
  if (!hold.freeze && video.readyState >= 2 && !video.seeking) {
    const frame = Math.floor(video.currentTime * FPS + 1e-3);
    const key = tile.join(',');
    if (frame !== hold.frame || key !== hold.tile || !hold.valid) {
      hold.ctx.drawImage(video, tile[0], tile[1], CW, CH, 0, 0, CW, CH);
      hold.valid = true;
      hold.frame = frame;
      hold.tile = key;
    }
  }
  if (hold.valid) ctx.drawImage(hold.canvas, x, y, CW, CH);
}
