#!/usr/local/bin/python3
"""Extract the soccer scene of 'walk the line' (2002) for the web version.

For every clip and both of its video tracks this writes
  media/fussball/<clip>_<track>.jpg   sprite sheet of all frames (COLS per row)
  media/fussball/<clip>_<track>.m4a   the matching audio track
and scenes/fussball.json describing timing and the ball's passes.

Each original .mov carries two video+audio pairs:
  streams 2/3 -> "fwd"  (ball travels to the right)
  streams 0/1 -> "back" (ball travels to the left)

A *pass* is the ball crossing a clip edge, stored as [[frame, x], ...] with x
in clip pixels (0..200) and monotonic in x.  Per track there is
  "in"  : the ball entering the clip   (used to start this clip in sync)
  "out" : the ball leaving the clip    (used to start the neighbour)
Every rolling pass is measured (measure_ball + fit_pass): a circle of the
ball's radius is fitted to the top outline of the moving blob, which also
works when the ball is cut off by the frame edge.  The three kicks in the end
clips take only 1-3 blurred frames and were read by eye (see PASSES).

Run with a Python that has numpy + cv2 (here /usr/local/bin/python3):
  python3 tools/extract.py "<path to 'alt + movs/fussball + movs'>" [--debug DIR]
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

W, H, COLS = 200, 150, 10
CLIPS = [  # screen order, left -> right
    ("links", "links ball after"),
    ("sand", "sand 2"),
    ("uebergang", "übergang ball"),
    ("a1", "a1 2"),
    ("rechts", "rechts ball"),
]
STREAMS = {"fwd": (2, 3), "back": (0, 1)}
RIGHT, LEFT = 1, -1

# Which ball passes each track has, and how they are obtained.
#   ("auto", dir, (first, last) frame window or None)   measured: see measure_ball / fit_pass
#   ("manual", dir, [[frame, x], ...])                  read by eye from labelled frames
# The kicks in the end clips are 1-3 motion-blurred frames, too few and too smeared
# to fit a circle, so they stay manual.  Everything that rolls is measured.
PASSES = {
    # opening shot: ball lies at x~120, man walks in and kicks it out to the right
    ("links", "fwd"): {"out": ("manual", RIGHT, [[81, 120], [82, 125], [83, 178], [84, 231]])},
    # ball rolls in from the right, is stopped, then kicked out to the right again
    ("links", "back"): {"in": ("auto", LEFT, (2, 10)),
                        "out": ("manual", RIGHT, [[52, 120], [53, 122], [54, 175], [55, 228]])},
    # ball rolls in from the left and is stopped by the foot; then "back" follows
    ("rechts", "fwd"): {"in": ("auto", RIGHT, (3, 14)), "then": "back"},
    # ball lies at x~78 and is kicked out to the left
    ("rechts", "back"): {"out": ("manual", LEFT, [[31, 80], [32, 20], [33, -40]])},
}
MIDDLE = {"fwd": ("auto", RIGHT, None), "back": ("auto", LEFT, None)}

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "media", "fussball")


def probe_fps(path, stream):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", str(stream),
         "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True).stdout.strip()
    n, d = r.split("/")
    return float(n) / float(d)


def read_frames(path, stream, fps):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-map", f"0:{stream}",
         "-fps_mode", "cfr", "-r", f"{fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)


def detect_ball(frames):
    """Rough per-frame ball x (or None): neutral white AND not background.

    Only used as a seed to pick the right blob in measure_ball."""
    bg = np.median(frames, axis=0).astype(np.int16)
    xs = []
    for f in frames:
        mn = f.min(axis=2).astype(np.int16)
        mx = f.max(axis=2).astype(np.int16)
        white = (mn > 160) & (mx - mn < 45)
        moving = np.abs(f.astype(np.int16) - bg).sum(axis=2) > 45
        m = cv2.dilate((white & moving).astype(np.uint8), np.ones((7, 7), np.uint8))
        n, _, st, _ = cv2.connectedComponentsWithStats(m)
        cand = [st[i] for i in range(1, n) if 30 < st[i][4] < 2000 and st[i][3] < 50 and st[i][2] < 60]
        if not cand:
            xs.append(None)
            continue
        x, y, w, h, a = max(cand, key=lambda s: s[4])
        xs.append(float(x + w / 2.0))
    return xs


def _moving_masks(frames):
    bg = np.median(frames, axis=0).astype(np.int16)
    close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    out = []
    for f in frames:
        m = (np.abs(f.astype(np.int16) - bg).max(axis=2) > 40).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        out.append(cv2.morphologyEx(m, cv2.MORPH_CLOSE, close))
    return out


def _upper_arc(mask, seed_x, box=None):
    """Top outline (x, y per column) of the moving blob nearest seed_x.

    With `box` = (cy, R) only a window around the expected ball is searched:
    columns seed_x +- (R + 8), rows from just above the ball top down to its
    centre.  That keeps legs above and the shadow below out of the outline.
    """
    if box is not None:
        cy, R = box
        x0 = int(max(0, seed_x - R - 8)); x1 = int(min(W, seed_x + R + 9))
        y0 = int(max(0, cy - R - 6)); y1 = int(min(H, cy + 2))
        if x1 - x0 < 4:
            return None
        sub = mask[y0:y1, x0:x1].astype(bool)
        cols = [c for c in range(sub.shape[1]) if sub[:, c].any() and not sub[0, c]]
        if len(cols) < 5:
            return None
        return (np.array(cols, float) + x0,
                np.array([np.argmax(sub[:, c]) for c in cols], float) + y0)
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
    cand = [i for i in range(1, n) if st[i][4] > 30 and abs(st[i][0] + st[i][2] / 2 - seed_x) < 45]
    if not cand:
        return None
    b = lab == max(cand, key=lambda k: st[k][4])
    cols = np.where(b.any(0))[0]
    return cols.astype(float), np.array([np.argmax(b[:, c]) for c in cols], float)


def _fit_circle_free(px, py):
    A = np.stack([px, py, np.ones_like(px)], 1)
    c, *_ = np.linalg.lstsq(A, px ** 2 + py ** 2, rcond=None)
    cx, cy = c[0] / 2, c[1] / 2
    return cx, cy, float(np.sqrt(c[2] + cx ** 2 + cy ** 2))


def _fit_circle_fixed(px, py, R, cx, cy):
    """Gauss-Newton fit of a circle of known radius R; the centre may lie off-frame."""
    res = np.zeros(1)
    for _ in range(30):
        dx, dy = px - cx, py - cy
        dist = np.hypot(dx, dy) + 1e-9
        res = dist - R
        step, *_ = np.linalg.lstsq(np.stack([-dx / dist, -dy / dist], 1), -res, rcond=None)
        cx, cy = cx + step[0], cy + step[1]
        if np.abs(step).max() < 0.01:
            break
    return cx, cy, float(np.sqrt(np.mean(res ** 2)))


def measure_ball(frames, window=None):
    """Per-frame ball centre (x, y) or None, plus the ball radius R.

    The ball is found as a moving blob (difference to the median frame).  Its
    shadow is part of that blob, but always lower, so only the blob's *top
    outline* is used: a circle of the clip's ball radius is fitted to it.  This
    also works when the ball is cut off by the frame edge, which is exactly
    where the hand-off between clips happens.
    """
    lo, hi = window or (0, len(frames) - 1)
    seeds = detect_ball(frames)
    masks = _moving_masks(frames)
    out, R = _measure(frames, masks, seeds, lo, hi, None)
    # second round: frames the white-panel seed missed (blur, edge) get a seed
    # predicted from the path found so far
    # predicted from the path found so far, and is searched for only in a box
    # around that prediction at the ball's height
    good = [(i, c[0], c[1]) for i, c in enumerate(out) if c]
    if len(good) >= 3:
        fr_, xs_, ys_ = (np.array(v, float) for v in zip(*good))
        cx_coef = np.polyfit(fr_, xs_, 2 if len(good) >= 5 else 1)
        cy_coef = np.polyfit(fr_, ys_, 1)
        boxes = [(float(np.polyval(cy_coef, i)), R) for i in range(len(frames))]
        seeds = [c[0] if c else float(np.polyval(cx_coef, i)) for i, c in enumerate(out)]
        out2, _ = _measure(frames, masks, seeds, lo, hi, R, boxes)
        out = [a or b for a, b in zip(out, out2)]
    return out, R


def _measure(frames, masks, seeds, lo, hi, R, boxes=None):
    arcs = [None] * len(frames)
    for i in range(lo, hi + 1):
        if seeds[i] is not None and -40 < seeds[i] < W + 40:
            arcs[i] = _upper_arc(masks[i], seeds[i], boxes[i] if boxes else None)
    radii = []
    for a in arcs:                      # radius from balls fully inside the frame
        if a is None or a[0][0] <= 1 or a[0][-1] >= W - 2 or len(a[0]) < 14:
            continue
        sel = a[1] < a[1].min() + 12
        if sel.sum() >= 8:
            r = _fit_circle_free(a[0][sel], a[1][sel])[2]
            if 8 < r < 30:
                radii.append(r)
    if R is None:
        R = float(np.median(radii)) if radii else 15.0
    out = [None] * len(frames)
    for i, a in enumerate(arcs):
        if a is None:
            continue
        cols, top = a
        sel = top < top.min() + 0.8 * R
        if sel.sum() < 5:
            continue
        cx0 = cols[sel][np.argmin(top[sel])]
        if cols[0] <= 1:
            cx0 = cols[-1] - R
        if cols[-1] >= W - 2:
            cx0 = cols[0] + R
        cx, cy, rms = _fit_circle_fixed(cols[sel], top[sel], R, float(cx0), top.min() + R)
        if rms < 2.5:
            out[i] = (cx, cy)
    # drop fits that latched onto the shadow or something else: wrong height
    ys = [c[1] for c in out if c]
    if ys:
        my = np.median(ys)
        out = [c if c and abs(c[1] - my) < max(5.0, 0.5 * R) else None for c in out]
    return out, R


def fit_pass(centres, R, direction, window=None):
    """Smooth ball path [[frame, x], ...] through the measured centres.

    A robust low-order polynomial x(frame) (the ball rolls smoothly) removes
    the per-frame measurement noise and gives sub-frame edge crossings.  The
    path is sampled every quarter frame and runs past both edges so the player
    can look up any x in 0..W.
    """
    lo, hi = window or (0, len(centres) - 1)
    pts = [(i, c[0]) for i, c in enumerate(centres) if c and lo <= i <= hi]
    f = np.array([p[0] for p in pts], float)
    x = np.array([p[1] for p in pts], float)
    deg = 3 if len(f) >= 10 else 2
    keep = np.ones(len(f), bool)
    for _ in range(5):
        coef = np.polyfit(f[keep], x[keep], deg)
        res = np.abs(np.polyval(coef, f) - x)
        new = res < max(2.5, 3.0 * np.median(res[keep]))
        if (new == keep).all():
            break
        keep = new
    rms = float(np.sqrt(np.mean(res[keep] ** 2)))
    # sample from beyond the entry edge to beyond the exit edge
    # (a windowed pass, e.g. a ball rolling in and stopping at a foot, must not be
    # extrapolated past its window: the ball stops there)
    f0 = f[keep].min() - 4 if window is None else max(f[keep].min() - 4, lo - 2)
    f1 = f[keep].max() + 4 if window is None else min(f[keep].max() + 4, hi)
    fs = np.arange(f0, f1 + 0.001, 0.25)
    xs = np.polyval(coef, fs)
    v = np.gradient(xs) * direction
    ok = (v > 0) & (xs > -R - 4) & (xs < W + R + 4)
    # keep the monotone stretch that contains the measured frames
    mid = int(np.argmin(np.abs(fs - np.median(f[keep]))))
    a = b = mid
    while a > 0 and ok[a - 1]:
        a -= 1
    while b < len(fs) - 1 and ok[b + 1]:
        b += 1
    path = [[round(float(fs[k]), 2), round(float(xs[k]), 1)] for k in range(a, b + 1)]
    return path, rms, int(keep.sum()), len(f)


def sprite_sheet(frames, path):
    rows = (len(frames) + COLS - 1) // COLS
    sheet = np.zeros((rows * H, COLS * W, 3), np.uint8)
    for i, f in enumerate(frames):
        r, c = divmod(i, COLS)
        sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = f
    cv2.imwrite(path, sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])


def extract_audio(path, stream, out):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-map", f"0:{stream}",
                    "-c:a", "aac", "-b:a", "96k", "-ac", "1", out], check=True)


def debug_sheet(frames, measured, path, out):
    """Contact sheet: measured circle (green), fitted path position (red), frame/x labels."""
    centres, R = measured
    fs = np.array([p[0] for p in path]); xs = np.array([p[1] for p in path])
    ys = [c[1] for c in centres if c]
    y = int(np.median(ys)) if ys else H // 2
    tiles = []
    for i, f in enumerate(frames):
        g = f.copy()
        if centres[i]:
            cv2.circle(g, (int(round(centres[i][0])), int(round(centres[i][1]))), int(round(R)), (0, 255, 0), 1)
        label = f"{i}"
        if fs[0] <= i <= fs[-1]:
            x = float(np.interp(i, fs, xs))
            cv2.line(g, (int(round(x)), y - int(R) - 4), (int(round(x)), y + int(R) + 4), (0, 0, 255), 1)
            label += f" {x:.0f}"
        cv2.putText(g, label, (2, 10), 0, 0.33, (0, 255, 255), 1)
        tiles.append(g)
    cols = 10
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * H, cols * W, 3), np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = t
    cv2.imwrite(out, sheet)


DEBUG = None


def main(src):
    os.makedirs(OUT, exist_ok=True)
    scene = {"id": "fussball", "title": "fussball", "clipWidth": W, "clipHeight": H,
             "cols": COLS, "start": {"clip": 0, "track": "fwd"}, "clips": []}
    for cid, name in CLIPS:
        mov = os.path.join(src, name + ".mov")
        clip = {"id": cid, "name": name, "tracks": {}}
        for tr, (vs, aus) in STREAMS.items():
            fps = probe_fps(mov, vs)
            frames = read_frames(mov, vs, fps)
            base = f"{cid}_{tr}"
            sprite_sheet(frames, os.path.join(OUT, base + ".jpg"))
            extract_audio(mov, aus, os.path.join(OUT, base + ".m4a"))
            track = {"image": f"media/fussball/{base}.jpg", "audio": f"media/fussball/{base}.m4a",
                     "fps": round(fps, 4), "frames": int(len(frames))}
            spec = PASSES.get((cid, tr)) or {"in": MIDDLE[tr], "out": MIDDLE[tr]}
            measured = None
            for key in ("in", "out"):
                if key not in spec:
                    continue
                kind, d, arg = spec[key]
                if kind == "manual":
                    track[key] = {"dir": d, "path": arg, "source": "manual"}
                    continue
                if measured is None:
                    measured = measure_ball(frames, arg)
                path, rms, n_used, n_meas = fit_pass(measured[0], measured[1], d, arg)
                if DEBUG:
                    debug_sheet(frames, measured, path, os.path.join(DEBUG, f"{base}_{key}.png"))
                track[key] = {"dir": d, "path": path, "source": "measured",
                              "radius": round(measured[1], 1), "rms": round(rms, 2)}
                print(f"{cid:9s} {tr:4s} {key:3s}: R={measured[1]:4.1f}px  {n_used:2d}/{n_meas:2d} frames  "
                      f"fit rms {rms:.2f}px  x {path[0][1]:.0f}..{path[-1][1]:.0f}")
            if "then" in spec:
                track["then"] = spec["then"]
            clip["tracks"][tr] = track
        scene["clips"].append(clip)
    os.makedirs(os.path.join(WEB, "scenes"), exist_ok=True)
    with open(os.path.join(WEB, "scenes", "fussball.json"), "w") as fh:
        json.dump(scene, fh, indent=1)


if __name__ == "__main__":
    # optional: --debug DIR writes a measurement contact sheet per measured pass
    if "--debug" in sys.argv:
        k = sys.argv.index("--debug")
        DEBUG = sys.argv[k + 1]
        os.makedirs(DEBUG, exist_ok=True)
        del sys.argv[k:k + 2]
    main(sys.argv[1])
