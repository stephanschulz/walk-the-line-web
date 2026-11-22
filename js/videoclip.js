// Drawing one tile of a mosaic <video> without flicker.
//
// After `currentTime` is set, a video keeps presenting its previous frame (or
// nothing) until the seek has landed, so drawing straight from it flashes the
// old picture.  Every clip therefore keeps its own copy of the last good frame
// and draws that; the copy is only refreshed when the video is not seeking.
// `freeze` keeps the copy unchanged on purpose (a clip a character has left).

export function makeHold(CW, CH) {
  const c = document.createElement('canvas');
  c.width = CW; c.height = CH;
  return { canvas: c, ctx: c.getContext('2d'), valid: false, freeze: false };
}

export function drawTile(ctx, video, hold, [tx, ty], x, y, CW, CH) {
  if (!hold.freeze && video.readyState >= 2 && !video.seeking) {
    hold.ctx.drawImage(video, tx, ty, CW, CH, 0, 0, CW, CH);
    hold.valid = true;
  }
  if (hold.valid) ctx.drawImage(hold.canvas, x, y, CW, CH);
}
