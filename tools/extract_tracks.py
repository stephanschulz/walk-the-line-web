#!/usr/local/bin/python3
"""Extract the multi-track scenes 'parität 360' and 'ritter' of walk the line (2002).

Their QuickTime movies hold many alternative video tracks (camera positions,
times of day) of which the Director movie switched one on at a time.  A
browser can't switch tracks, so all video tracks of a movie are tiled into ONE
H.264 video (a mosaic, with a black gutter so neighbouring tiles never bleed).
The player decodes the mosaic and draws the chosen tile, which makes switching
perspective / time of day instant.

  media/paritaet/rund.mp4               20 tracks, 5 x 4 tiles
  media/ritter/<movie>.mp4              treffen tausch / hand / kampf, warten weiss / rot
  media/ritter/<movie>.m4a              the meeting sound tracks, and the 'cash' ambience
  scenes/paritaet.json, scenes/ritter.json   tile layout + original durations

Durations are QuickTime *movie* durations (longest track, sound included):
that is what Lingo's sprite(n).duration meant, and the ported timing uses it.
Track numbers are kept as in Lingo: track k = ffmpeg stream k-1.

  python3 tools/extract_tracks.py "<path to 'alt + movs'>"
"""
import json
import os
import subprocess
import sys

W, H, GUT, FPS = 200, 150, 4, 15
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)


def ffprobe(args):
    return subprocess.run(["ffprobe", "-v", "error"] + args, capture_output=True, text=True, check=True).stdout


def streams(path):
    rows = ffprobe(["-show_entries", "stream=index,codec_type", "-of", "csv=p=0", path]).split()
    return [(int(r.split(",")[0]), r.split(",")[1]) for r in rows]


def movie_duration(path):
    return float(ffprobe(["-show_entries", "format=duration", "-of", "csv=p=0", path]).strip())


def mosaic(src, video_streams, cols, out):
    """Tile the given video streams (in order) into one H.264 file; returns tile rects."""
    n = len(video_streams)
    rows = (n + cols - 1) // cols
    pw, ph = W + GUT, H + GUT
    parts, labels, layout, tiles = [], [], [], []
    for k, s in enumerate(video_streams):
        r, c = divmod(k, cols)
        # every track to constant 15 fps and padded with a black gutter (right + bottom)
        parts.append(f"[0:{s}]fps={FPS},scale={W}:{H},setsar=1,pad={pw}:{ph}:0:0:black[v{k}]")
        labels.append(f"[v{k}]")
        layout.append(f"{c * pw}_{r * ph}")
        tiles.append([c * pw, r * ph])
    # pad the grid to full rows with black so xstack has a rectangle
    for k in range(n, rows * cols):
        r, c = divmod(k, cols)
        parts.append(f"color=black:s={pw}x{ph}:r={FPS}[v{k}]")
        labels.append(f"[v{k}]")
        layout.append(f"{c * pw}_{r * ph}")
    total = rows * cols
    graph = ";".join(parts) + ";" + "".join(labels) + \
        f"xstack=inputs={total}:layout={'|'.join(layout)}:shortest=0[out]"
    if total == 1:
        graph = parts[0].replace(f"[v0]", "[out]")
    dur = movie_duration(src)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", graph, "-map", "[out]",
                    "-t", f"{dur:.3f}", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p",
                    "-g", "5", "-keyint_min", "5", "-sc_threshold", "0", "-r", str(FPS),
                    "-movflags", "+faststart", "-an", out], check=True)
    return tiles, cols * pw, rows * ph


def audio(src, stream, out, br="96k"):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-map", f"0:{stream}", "-c:a", "aac",
                    "-b:a", br, "-ac", "1", out], check=True)


def entry(name, src, cols, out_dir, rel):
    vids = [i for i, t in streams(src) if t == "video"]
    tiles, mw, mh = mosaic(src, vids, cols, os.path.join(out_dir, f"{name}.mp4"))
    # Lingo track k (1-based over ALL tracks, sound included) -> tile
    track_tiles = {str(i + 1): tiles[k] for k, i in enumerate(vids)}
    print(f"{name:10s} {len(vids):2d} video tracks -> {mw}x{mh}, {movie_duration(src):.3f}s, "
          f"{os.path.getsize(os.path.join(out_dir, name + '.mp4')) / 1e6:.1f} MB")
    return {"video": f"{rel}/{name}.mp4", "tiles": track_tiles, "duration": round(movie_duration(src), 4)}


def main(root):
    # ---- parität 360 -------------------------------------------------------
    out = os.path.join(WEB, "media", "paritaet")
    os.makedirs(out, exist_ok=True)
    pari = {"id": "paritaet", "clipWidth": W, "clipHeight": H,
            "movie": entry("rund", os.path.join(root, "parität + movs", "parität rund.mov"), 5, out, "media/paritaet")}
    with open(os.path.join(WEB, "scenes", "paritaet.json"), "w") as fh:
        json.dump(pari, fh, indent=1)

    # ---- ritter ------------------------------------------------------------
    src = os.path.join(root, "ritter + movs", "walk the line reduz neu")
    out = os.path.join(WEB, "media", "ritter")
    os.makedirs(out, exist_ok=True)
    rel = "media/ritter"
    movies = [("weiss", "warten weiß.mov Kopie", 1), ("tausch", "treffen tausch frei + ton.mov", 3),
              ("hand", "treffen hand frei + ton.mov", 3), ("kampf", "treffen kampf frei+ton.mov", 3),
              ("rot", "warten rot.mov", 1)]
    rit = {"id": "ritter", "clipWidth": W, "clipHeight": H, "movies": {}}
    for name, fname, cols in movies:
        path = os.path.join(src, fname)
        e = entry(name, path, cols, out, rel)
        snd = [i for i, t in streams(path) if t == "audio"]
        if snd:                                    # meeting sound = Lingo track 1
            audio(path, snd[0], os.path.join(out, f"{name}.m4a"))
            e["audio"] = f"{rel}/{name}.m4a"
        rit["movies"][name] = e
    audio(os.path.join(src, "cash.mov"), 0, os.path.join(out, "cash.m4a"), "64k")
    rit["ambience"] = {"audio": f"{rel}/cash.m4a", "duration": round(movie_duration(os.path.join(src, "cash.mov")), 3)}
    with open(os.path.join(WEB, "scenes", "ritter.json"), "w") as fh:
        json.dump(rit, fh, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
