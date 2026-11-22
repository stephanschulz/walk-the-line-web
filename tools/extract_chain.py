#!/usr/local/bin/python3
"""Extract the walking scenes 'stadt' (speed) and 'ton' of walk the line (2002).

Both are one-directional chains: a person walks left -> right through every
clip, and the chain wraps around.  For every clip this writes

  media/<scene>/<clip>.jpg     sprite sheet of all frames (COLS per row)
  media/<scene>/<clip>.m4a     the clip's own sound            (stadt)
  media/<scene>/<clip>_still.jpg  the empty place, shown while a clip rests or is picked up
  media/ton/layer<k>.m4a       the five soundtrack layers of 'incu Kopie.mov' (ton)

and scenes/<scene>.json with the walker's pass ([[frame, x], ...]) per clip.

Walker position: the person is the largest moving blob (difference to the
median frame).  Only the upper body is used (the legs swing), and in stadt
only red pixels (the runner's shirt), so passing cars are ignored.  A straight
line / gentle curve through the frames where the person is fully inside the
clip gives the moment the body crosses any x, including both edges.

  python3 tools/extract_chain.py "<path to 'alt + movs'>" [--debug DIR]
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

W, H, COLS = 200, 150, 10
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)

# clip order = sprite order in the Director score
SCENES = {
    "stadt": {
        "dir": "speed + movs",
        "clips": [("baum", "baum1.mov"), ("wiese", "wise6.mov"), ("haus", "haus1.mov"), ("k4", "k4.mov"),
                  ("k2", "k2 1.mov"), ("hoch", "hoch3.mov"), ("stadt", "stadt2.mov"), ("spiegel", "spiegel1.mov")],
        "audio_stream": 1, "red": True,
    },
    "ton": {
        "dir": "ton + movs",
        "clips": [("incu", "incu film.mov"), ("count", "count film.mo"), ("head", "head film.mov"),
                  ("fatb", "fatb film.mov"), ("baba", "baba film.mov")],
        "layers": "incu Kopie.mov", "red": False,
    },
}
DEBUG = None


def probe(path, stream, entry):
    return subprocess.run(["ffprobe", "-v", "error", "-select_streams", str(stream), "-show_entries",
                           f"stream={entry}", "-of", "csv=p=0", path],
                          capture_output=True, text=True, check=True).stdout.strip()


def fps_of(path):
    n, d = probe(path, 0, "avg_frame_rate").split("/")
    return float(n) / float(d)


def read_frames(path, stream, fps):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", f"0:{stream}", "-fps_mode", "cfr",
                          "-r", f"{fps}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)


def walker_x(frames, red):
    """Per-frame upper-body x of the walker, and whether the body touches a frame edge."""
    bg = np.median(frames, axis=0).astype(np.int16)
    out = []
    for f in frames:
        fi = f.astype(np.int16)
        m = np.abs(fi - bg).max(axis=2) > 35
        if red:
            b, g, r = fi[..., 0], fi[..., 1], fi[..., 2]
            m &= (r > g + 35) & (r > b + 35)
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 5), np.uint8))
        n, lab, st, _ = cv2.connectedComponentsWithStats(m)
        cand = [i for i in range(1, n) if st[i][4] > (15 if red else 40)]
        if not cand:
            out.append(None)
            continue
        i = max(cand, key=lambda k: st[k][4])
        x, y, w, h, a = st[i]
        blob = lab[y:y + h, x:x + w] == i
        upper = blob[: max(2, int(h * (0.6 if red else 0.45)))]     # head + torso
        cols = np.where(upper.any(0))[0]
        cx = x + (cols.mean() if len(cols) else w / 2)
        touching = x <= 1 or x + w >= W - 1
        out.append((float(cx), touching))
    return out


def fit_path(meas):
    """Robust low-order fit x(frame) through the frames where the walker is fully inside."""
    pts = [(i, m[0]) for i, m in enumerate(meas) if m and not m[1]]
    f = np.array([p[0] for p in pts], float)
    x = np.array([p[1] for p in pts], float)
    deg = 2 if len(f) >= 12 else 1
    keep = np.ones(len(f), bool)
    for _ in range(6):
        coef = np.polyfit(f[keep], x[keep], deg)
        res = np.abs(np.polyval(coef, f) - x)
        new = res < max(3.0, 3.0 * np.median(res[keep]))
        if (new == keep).all():
            break
        keep = new
    rms = float(np.sqrt(np.mean(res[keep] ** 2)))
    if rms > 3.0:
        # the walker changes pace (spiegel: sprints in, then walks): follow the
        # measurements themselves, median-smoothed and made monotone, with the
        # end speeds extrapolated past both edges
        return _piecewise_path(f, x)
    # sample the fitted pass from well before x=0 to well after x=W (monotone part)
    fs = np.arange(f[keep].min() - 40, f[keep].max() + 40.001, 0.25)
    xs = np.polyval(coef, fs)
    ok = (np.gradient(xs) > 0) & (xs > -40) & (xs < W + 40)
    mid = int(np.argmin(np.abs(fs - np.median(f[keep]))))
    a = b = mid
    while a > 0 and ok[a - 1]:
        a -= 1
    while b < len(fs) - 1 and ok[b + 1]:
        b += 1
    path = [[round(float(fs[k]), 2), round(float(xs[k]), 1)] for k in range(a, b + 1)]
    return path, rms, int(keep.sum()), len(f)


def _piecewise_path(f, x):
    k = 2
    xm = np.array([np.median(x[max(0, i - k):i + k + 1]) for i in range(len(x))])
    good = np.abs(xm - x) < 6                     # drop single-frame outliers (reflections)
    f, x = f[good], np.maximum.accumulate(np.array([np.median(x[good][max(0, i - 1):i + 2])
                                                     for i in range(good.sum())]))
    v0 = max(0.5, (x[min(4, len(x) - 1)] - x[0]) / max(1, f[min(4, len(f) - 1)] - f[0]))
    v1 = max(0.5, (x[-1] - x[max(0, len(x) - 5)]) / max(1, f[-1] - f[max(0, len(f) - 5)]))
    head = [[round(float(f[0] - (x[0] + 40) / v0), 2), -40.0]] if x[0] > -40 else []
    tail = [[round(float(f[-1] + (W + 40 - x[-1]) / v1), 2), float(W + 40)]] if x[-1] < W + 40 else []
    body = [[round(float(a), 2), round(float(b), 1)] for a, b in zip(f, x)]
    res = np.abs(np.interp(f, f, x) - x)
    return head + body + tail, float(np.sqrt(np.mean(res ** 2))), int(len(f)), int(len(good))


def sprite_sheet(frames, path):
    rows = (len(frames) + COLS - 1) // COLS
    sheet = np.zeros((rows * H, COLS * W, 3), np.uint8)
    for i, f in enumerate(frames):
        r, c = divmod(i, COLS)
        sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = f
    cv2.imwrite(path, sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])


def audio(src, stream, out):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-map", f"0:{stream}", "-c:a", "aac",
                    "-b:a", "96k", "-ac", "1", out], check=True)


def debug_sheet(frames, meas, path, out):
    fs = np.array([p[0] for p in path]); xs = np.array([p[1] for p in path])
    tiles = []
    for i, f in enumerate(frames):
        g = f.copy()
        if meas[i]:
            cv2.circle(g, (int(meas[i][0]), 20), 3, (0, 255, 0) if not meas[i][1] else (0, 160, 255), -1)
        x = float(np.interp(i, fs, xs))
        cv2.line(g, (int(round(x)), 0), (int(round(x)), H - 1), (0, 0, 255), 1)
        cv2.putText(g, f"{i} {x:.0f}", (2, 10), 0, 0.33, (0, 255, 255), 1)
        tiles.append(g)
    rows = (len(tiles) + COLS - 1) // COLS
    sheet = np.zeros((rows * H, COLS * W, 3), np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, COLS)
        sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = t
    cv2.imwrite(out, sheet)


def build(name, cfg, root):
    src = os.path.join(root, cfg["dir"])
    out_dir = os.path.join(WEB, "media", name)
    os.makedirs(out_dir, exist_ok=True)
    scene = {"id": name, "clipWidth": W, "clipHeight": H, "cols": COLS, "clips": []}
    for k, (cid, fname) in enumerate(cfg["clips"]):
        mov = os.path.join(src, fname)
        fps = fps_of(mov)
        frames = read_frames(mov, 0, fps)
        sprite_sheet(frames, os.path.join(out_dir, f"{cid}.jpg"))
        meas = walker_x(frames, cfg["red"])
        path, rms, used, n = fit_path(meas)
        clip = {"id": cid, "name": fname.rsplit(".", 1)[0], "fps": round(fps, 4), "frames": int(len(frames)),
                "image": f"media/{name}/{cid}.jpg", "path": path, "rms": round(rms, 2)}
        if "audio_stream" in cfg:
            audio(mov, cfg["audio_stream"], os.path.join(out_dir, f"{cid}.m4a"))
            clip["audio"] = f"media/{name}/{cid}.m4a"
        # the empty place: shown while a clip rests (frame 0 can already show the
        # walker entering) and while it is picked up for a swap.  The median of
        # all frames is exactly that — the walker never stays in one spot.
        still = np.median(frames, axis=0).astype(np.uint8)
        cv2.imwrite(os.path.join(out_dir, f"{cid}_still.jpg"), still, [cv2.IMWRITE_JPEG_QUALITY, 88])
        clip["still"] = f"media/{name}/{cid}_still.jpg"
        if "layers" in cfg:   # each film owns the soundtrack layer of its original position
            audio(os.path.join(src, cfg["layers"]), k, os.path.join(out_dir, f"layer{k}.m4a"))
            clip["layer"] = f"media/{name}/layer{k}.m4a"
        if DEBUG:
            debug_sheet(frames, meas, path, os.path.join(DEBUG, f"{name}_{cid}.png"))
        scene["clips"].append(clip)
        print(f"{name:6s} {cid:8s} {len(frames):3d}f @{fps:5.2f}  {used:3d}/{n:3d} frames  rms {rms:4.2f}px  "
              f"x {path[0][1]:.0f}..{path[-1][1]:.0f} over frames {path[0][0]:.0f}..{path[-1][0]:.0f}")
    os.makedirs(os.path.join(WEB, "scenes"), exist_ok=True)
    with open(os.path.join(WEB, "scenes", f"{name}.json"), "w") as fh:
        json.dump(scene, fh, indent=1)


if __name__ == "__main__":
    if "--debug" in sys.argv:
        k = sys.argv.index("--debug")
        DEBUG = sys.argv[k + 1]
        os.makedirs(DEBUG, exist_ok=True)
        del sys.argv[k:k + 2]
    for name, cfg in SCENES.items():
        build(name, cfg, sys.argv[1])
