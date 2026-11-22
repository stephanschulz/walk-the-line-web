#!/usr/local/bin/python3
"""Measure when the knights cross the clip edges in ritter's movies.

For every video track of every ritter movie this finds the intervals in which
something moving occupies the left edge band and the right edge band of the
picture.  An interval [a, b] (seconds of movie time) is a rider passing that
edge: a = his front touches the edge, b = his back has cleared it; the middle
is when his centre crosses.  The player starts the next clip so that the
centre crossings of both clips coincide (js/ritter.js).

Writes movies[<name>].edges[<Lingo track>] = {"L": [[a, b], ...], "R": [...]}
into scenes/ritter.json (run tools/extract_tracks.py first).

  python3 tools/measure_riders.py "<path to 'alt + movs'>" [--debug DIR]
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

W, H, FPS = 200, 150, 15
BAND = 4                     # px at each edge
ROWS = slice(10, 140)        # ignore sky/ground margins
MIN_PX = 10                  # moving pixels in the band to count as "occupied"
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
FILES = {"weiss": "warten weiß.mov Kopie", "tausch": "treffen tausch frei + ton.mov",
         "hand": "treffen hand frei + ton.mov", "kampf": "treffen kampf frei+ton.mov", "rot": "warten rot.mov"}


def streams(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=index,codec_type", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout.split()
    return [(int(r.split(",")[0]), r.split(",")[1]) for r in out]


def frames_of(path, stream):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", f"0:{stream}", "-vf", f"fps={FPS},scale={W}:{H}",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)


def intervals(occ):
    out, start = [], None
    for i, o in enumerate(list(occ) + [False]):
        if o and start is None:
            start = i
        if not o and start is not None:
            if i - start >= 2:                     # ignore single-frame flicker
                out.append([start, i - 1])
            start = None
    return out


def measure(frames, empty_start=False):
    # background = the empty place.  Usually the median frame; in the meeting
    # tracks a knight stands near one edge for most of the clip, so there the
    # first frame (nobody has arrived yet) is used instead.
    bg = (frames[0] if empty_start else np.median(frames, axis=0)).astype(np.int16)
    mask = np.abs(frames.astype(np.int16) - bg).max(axis=3) > 45
    left = mask[:, ROWS, :BAND].sum(axis=(1, 2)) >= MIN_PX
    right = mask[:, ROWS, W - BAND:].sum(axis=(1, 2)) >= MIN_PX
    # frame index -> seconds; an interval covers [first frame, last frame + 1)
    sec = lambda iv: [round(iv[0] / FPS, 3), round((iv[1] + 1) / FPS, 3)]
    return {"L": [sec(iv) for iv in intervals(left)], "R": [sec(iv) for iv in intervals(right)]}, left, right


def debug_sheet(frames, left, right, out):
    tiles = []
    for i, f in enumerate(frames[::2]):
        g = f.copy()
        k = i * 2
        if left[k]:
            g[:, :BAND] = (0, 255, 0)
        if right[k]:
            g[:, W - BAND:] = (0, 0, 255)
        cv2.putText(g, f"{k / FPS:.1f}", (4, 12), 0, 0.35, (0, 255, 255), 1)
        tiles.append(cv2.resize(g, (100, 75)))
    cols = 16
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * 75, cols * 100, 3), np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * 75:(r + 1) * 75, c * 100:(c + 1) * 100] = t
    cv2.imwrite(out, sheet)


def main(root, debug=None):
    src = os.path.join(root, "ritter + movs", "walk the line reduz neu")
    path_json = os.path.join(WEB, "scenes", "ritter.json")
    data = json.load(open(path_json))
    for name, fname in FILES.items():
        path = os.path.join(src, fname)
        edges = {}
        for s, kind in streams(path):
            if kind != "video":
                continue
            fr = frames_of(path, s)
            meeting = name in ("tausch", "hand", "kampf") and s + 1 in (2, 3, 4)
            e, left, right = measure(fr, empty_start=meeting)
            edges[str(s + 1)] = e                 # Lingo track number
            print(f"{name:7s} track {s + 1:2d}  L {e['L']}  R {e['R']}")
            if debug:
                debug_sheet(fr, left, right, os.path.join(debug, f"rit_{name}_{s + 1}.png"))
        data["movies"][name]["edges"] = edges
    json.dump(data, open(path_json, "w"), indent=1)


if __name__ == "__main__":
    dbg = None
    if "--debug" in sys.argv:
        k = sys.argv.index("--debug")
        dbg = sys.argv[k + 1]
        os.makedirs(dbg, exist_ok=True)
        del sys.argv[k:k + 2]
    main(sys.argv[1], dbg)
