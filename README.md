# walk the line — web version

**▶ Open the web app: https://stephanschulz.github.io/walk-the-line-web/**

Project page: https://stephanschulz.ca/projects/walk-the-line-2002/

A web port of *walk the line* (Stephan Schulz, Director, 2002): the menu and the five scenes
whose files are in this folder.

| scene | what happens | interaction |
|---|---|---|
| **fussball** | a ball is kicked through five clips, back and forth | drag a clip left over its neighbour |
| **stadt** | a runner in red crosses eight places; the row is wider than the 1024 px stage, and when he reaches the stage edge he starts again at the left | drag; double-click a clip, then click another to swap them |
| **ton** | five different walkers, one after the other, each with their own layer of the soundtrack | drag; double-click + click to swap |
| **parität** | one person crossing a square, seen from 10 camera positions | click the left or right half of a clip to change its perspective (this can turn the person around) |
| **ritter** | two knights on hobby horses wait, ride towards each other and meet | the first click on a middle clip picks the meeting place; every click on a middle clip changes its time of day |

The menu movie also links to `proto`, `exFilm`, `ritterV`, `ton-mix`, `pariTON`, `pariBild` and `abspann`.
Those files are not in this folder, so they are not ported.

## Run

Browsers block `fetch`/Web Audio on `file://`, so serve the folder:

    cd web
    python3 -m http.server 8931 --bind 127.0.0.1
    open http://127.0.0.1:8931/

Pick a scene in the menu; a click is needed once for sound. Deep links work too, e.g.
`http://127.0.0.1:8931/#stadt`. In a scene:
- **reset** (or `R`) restarts it.
- **menu** (or `Esc`) goes back to the menu.
- `D` toggles a debug overlay with each clip's state.

### Idle mode

If nobody interacts for 20 seconds, the scene plays by itself. How depends on the scene:
- **Drag scenes:** an invisible hand slides one clip at a time slowly (about 18 px/s) to a new overlap, then pauses 1.5–4 s.
- **parität:** every 3–7 s a perspective changes, mostly on the clip the person is in.
- **ritter:** if the knights are waiting, a meeting place is picked for them.

Any click or drag stops this immediately. Change the delay with `?idle=<seconds>`.
The drag speed and the smallest overlap are `AUTO_SPEED` / `AUTO_MIN_GAP` in `js/handoff.js`.

## Code

- `js/main.js` — the core: the 1024 × 150 stage on one canvas, the clock, Web Audio, the menu and `#scene` routing, and the idle timer.
- `js/handoff.js` — the drag scenes (fussball, stadt, ton).
- `js/paritaet.js` — parität 360, a direct port of `pari360.dir`: the tick tables and the perspective logic.
- `js/ritter.js` — ritter, based on `ritterR.dir`. Routes, tracks, rates and click logic are the original's; the timing is measured.
  - **Handoffs:** the Lingo's fixed tick offsets made the knights vanish or double between clips. Now the next clip starts at the moment the knight's front reaches the edge, using the measured edge crossings (`tools/measure_riders.py`).
  - **Departures:** each knight leaves at the time that makes both of them arrive in the meeting clip when its footage expects them.

Clip order, row positions and soundtrack assignment come from the Director score (`VWSC`) and the cast.
The stage size (1024 × 768) comes from the movie config (`DRCF`).

### Drag scenes: continuous motion across seams

All drag-scene frames are JPEG sprite sheets drawn from one clock, so seeks and handoffs are frame exact.
For every clip, the JSON stores when the travelling object (ball or person) crosses each x position: its **in** and **out** passes, as `[frame, x]` samples.
- **The handoff:** when the traveller in one clip reaches the visible edge of that clip, the next clip starts at the moment its own traveller is at the same screen position.
  This replaces the hand-measured Lingo tables (`entra`, `ueber2`), which were tuned around QuickTime's start-up lag in 2002.
- **Which frame shows:** each clip shows the frame *nearest* the clock, so 15 fps and 25 fps clips stay in phase.
- **fussball:** each `.mov` holds a ball-going-right and a ball-going-left video+audio pair (streams 2/3 and 0/1).
  At the ends the ball is kicked back (ping-pong).
- **stadt / ton:** the walker goes one way.
  - **Wrap-around:** when he leaves the last clip, or reaches the stage edge, clip 1 starts again.
  - **Rewind:** a clip goes back to its first frame once he has left it.
  - **Swap:** swapping moves a film together with its timing and its sound.
  - **ton soundtrack:** ton uses the 5-layer soundtrack `incu Kopie.mov`; layer k belongs to the film that originally sat at position k.

### parität / ritter: multi-track movies

Their QuickTime movies hold many alternative video tracks, and Director switched one on at a time:
- **parität:** 20 tracks, 10 camera positions × 2 walking directions.
- **ritter:** each meeting movie holds the meeting plus ride-through versions, in three times of day.

A browser can't switch tracks, so each movie is tiled into **one H.264 mosaic**, with a black gutter and a keyframe every 5 frames.
- **Drawing:** each clip has its own (invisible) `<video>` and draws the tile of its current track, so switching is instant.
- **Timing:** the ported Lingo works in Director ticks (1/60 s) on the original QuickTime movie durations, which are stored in the scene JSON.

## Rebuilding the media (numpy + opencv + ffmpeg)

    P=/usr/local/bin/python3; SRC="../walk the line-small/alt + movs"
    $P tools/extract.py "$SRC/fussball + movs" [--debug DIR]   # fussball: sprite sheets + ball passes
    $P tools/extract_chain.py "$SRC" [--debug DIR]             # stadt + ton: sprite sheets + walker passes
    $P tools/extract_tracks.py "$SRC"                          # parität + ritter: mosaic videos + sound
    $P tools/measure_riders.py "$SRC" [--debug DIR]            # ritter: when each knight crosses each clip edge

How the passes are measured:
- **Ball:** a circle of the ball's radius is fitted to the top outline of the moving blob. That also works when the ball is cut off by the frame edge.
  The three kicks (1–3 blurred frames) were read by eye; they are in `PASSES` in `extract.py`.
- **Walkers:** upper body of the moving blob (in stadt only the red shirt, so cars don't count), with a straight line or gentle curve through the frames where the person is fully visible.
  The spiegel runner sprints, stops, then walks on, so his path follows the measurements point by point instead.
- `--debug DIR` writes a contact sheet per pass with the measurements and the fitted path.

To check seams in a drag scene, load `tools/seamstrip.js` in the running page.
`seamStrip({seam, gaps, dir})` returns a film strip of crops around one seam, stepped frame by frame.
