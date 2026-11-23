# Leonida Clipper Studio

A free, static manual clip editor for Leonida Nights — inspired by Yizerge,
built on our own Leonida Clipper Pro code. Upload a video, arrange two (or
more) boxes on the frame, pick your moment on the timeline, add a headline
and captions, and export an MP4 — all in your browser. No server, no API
key, no account, no watermark. Your video file never leaves your device.

## What it does

- **Upload video files** — one main video, optionally a second video (a
  separate facecam recording) with a ±5s sync slider. No YouTube-link paste:
  a link needs a server to fetch the video, and this site has no server.
- **Two-box layouts (the key feature)** — game full-bleed with a draggable,
  resizable facecam box (corner presets), 50/50 speaker split for podcasts,
  game-on-top + strip below, and picture-in-picture. Boxes show live video
  in the preview, exactly as the export will look. With one video, each box
  crops a different region of it — pick each box's source region by dragging
  the frame over the video in the crop editor.
- **Up to 4 boxes** — add boxes for 3–4 person podcasts. Each box has its
  own video source, its own crop region, its own drag/resize, and its own
  face-tracking toggle. An Auto-arrange button lays boxes out in a grid.
- **Per-box face tracking** — turn "Track face" on for any box and its crop
  follows the detected face as the person moves; leave it off and the box
  stays a fixed static crop. Tracking is computed **in your browser during
  export** (MediaPipe BlazeFace, ~2 frames/second, smoothed), not live in
  the preview — a tracked box shows a dashed pink border here. If no face
  is found in the clip, that box simply stays still and the export still
  completes. The moving crop is applied with ffmpeg `sendcmd` commands.
- **Game / Podcast mode switch** — Game clipping defaults to game +
  facecam layouts (boxes labelled GAME / CAM); Podcast clipping defaults to
  the 50/50 speaker split (boxes labelled SPK 1, SPK 2…). The mode only
  changes defaults and labels — the box engine is identical.
- **Manual In / Out** — timeline scrubber with audio waveform and frame
  thumbnails, draggable In/Out markers, clip-length readout, and a dashed
  60-second guide line (the Shorts length). Any length works.
- **Canvas sizes** — 9:16 (1080×1920, default), 1:1 (1080×1080),
  16:9 (1920×1080).
- **Captions** — the same 5 subtitle styles as Leonida Clipper Pro (bold
  yellow word-pop, white bold/black outline, karaoke, minimal lower-third,
  neon pink Leonida Nights default), burned in via ffmpeg ASS. Caption
  sources: subtitles embedded in the video, an uploaded .srt/.vtt file, or
  words typed for the clip (spread evenly). No automatic transcription.
- **Headline hook + handle** — big hook text at the top of the frame
  (auto-wrapped so it never overflows) and an optional name/handle overlay.
- **Export** — ffmpeg.wasm, H.264 + AAC, exact canvas size, no watermark,
  MP4 download. In-browser export is slow: several minutes for a 60-second
  clip.

## How to use it

1. Upload your main video (drop it on the box, or tap to choose).
   Add a second video if you have one, and nudge the sync slider if the
   two drift apart.
2. Pick a canvas size and a layout. Drag boxes to move them, drag a pink
   corner to resize. Tap a box to select it, then set its source region in
   the crop editor below the preview. Add boxes (up to 4) or Auto-arrange
   them into a grid. Turn "Track face" on for any box you want to follow
   a person.
3. Scrub the timeline (waveform + thumbnails), drag the IN/OUT markers or
   use the Set In / Set Out buttons.
4. Type a headline hook and a handle, pick a subtitle style, and check or
   type the captions.
5. Press Export Clip. Keep the tab open — cutting happens on your device.

## Files

- `index.html` — the page (neon sunset Leonida Nights look).
- `studio.js` — all UI + export logic. Pure helpers are imported from
  `layout.js` / `captions.js` and unit-tested in Node.
- `layout.js` — pure box math: presets, corner snapping, clamping,
  auto-arrange grid, and the ffmpeg filter graph (incl. tracked boxes).
- `captions.js` — pure caption helpers: SRT/VTT parsing, word timing, and
  ASS generation for all 5 styles (+ headline/handle overlays).
- `tests.mjs` — Node tests (`node tests.mjs`).
- `assets/logo.png` — the LEONIDA CLIPPER text logo; `favicon.png`.
- `vendor/ffmpeg/` — vendored ffmpeg.wasm worker (same files as Leonida
  Clipper Pro Online, so the worker is same-origin on GitHub Pages).

## How the pieces fit together

- Cutting runs on ffmpeg.wasm: the core loads from the jsDelivr CDN on
  first run (~30 MB); the worker script is vendored here because browsers
  refuse to construct a Worker from a cross-origin script.
- Each box becomes a `crop → scale` chain in one filter graph, composited
  onto a `nullsrc` canvas with `overlay`s. The main video's audio is kept.
- Face tracking: MediaPipe Tasks Vision (BlazeFace, loaded from CDN only
  when a box has tracking on) scans the clip at ~2 fps, picks the face
  nearest each tracked box's region, smooths the path (5-tap moving
  average, max 8% of the frame per step), and writes an ffmpeg `sendcmd`
  script that moves that box's named `crop` filter (`crop@trkN`) as the
  clip plays. No face found → that box keeps its static crop.

## Honest limits

- **You pick every moment yourself.** Nothing here finds the best moments
  for you — Leonida Clipper Pro does that automatically.
- **No YouTube links, no auto-transcription** (see above — both need a
  server or a paid service, and this site has neither).
- **Face tracking is export-time, not live.** The preview shows tracked
  boxes with a dashed border; the movement only appears in the export. It
  follows the face nearest each box's region and can lose it if the person
  leaves the frame, turns away, or another face is closer. It adds a few
  extra seconds (sampling + detection) before the cut starts.
- **Export is slow in a browser** (several minutes per 60s clip) and
  videos over ~1 GB can be slow or run out of browser memory.
- **Fonts:** burned-in captions use the Pro style colours, sizes and
  outlines, but the font face falls back to ffmpeg.wasm's built-in font
  ("Arial Black" is not bundled with the wasm core).
- The tool does not grant permission to clip anyone's video: only use it
  on creators who have given permission to clip their videos.

## Verified (2026-11-23, this VM)

- Node tests: `node tests.mjs` — 166 checks, all passing: every preset ×
  canvas size × single/two-video (boxes inside the canvas, valid crops,
  even pixel sizes), corner snapping, clamping, auto-arrange grids for
  1–4 boxes (no overlap, flags kept, hand-set crops preserved), tracked
  filter graphs (`sendcmd` + named crop only on tracked boxes), SRT
  parsing, word timing, and ASS generation for all 5 styles × 3 canvas
  sizes (incl. headline wrap + handle).
- Real ffmpeg test: the exact filter graph the code generates (game-facecam
  preset, box 2 tracked via a sendcmd script, headline + handle ASS) was
  run through system ffmpeg on a test video — output verified 1080×1920,
  H.264 + AAC, 4.000s; frames at 0.5s / 2.5s / 3.5s differ (tracked crop
  moves); headline + handle visibly burned in (checked frame grabs).
- `sendcmd` + named `crop@trk0` moving-crop mechanism verified separately
  on system ffmpeg (frames differ as the crop moves).
- Local serve check: `python3 -m http.server` — index.html, studio.js,
  layout.js, captions.js, logo, favicon and all 3 vendor files return
  HTTP 200. jsDelivr ffmpeg core + MediaPipe bundle/WASM/model URLs all
  return HTTP 200.
- **Not verified:** a full in-browser run (no Chromium on this VM) — the
  ffmpeg.wasm load + cut path is the same proven pattern as Leonida
  Clipper Pro Online, and the MediaPipe detector has not been run against
  a real face in a browser yet. Verify once on Pages: upload a video,
  turn tracking on for one box, export, and check the box follows the face.

## Deploy (for the parent agent — do not deploy from here)

Copy this folder's contents into a repo (e.g. a new `leonida-clipper-studio`
repo, or `docs/` in an existing one), push to `main`, then Settings →
Pages → Source: "Deploy from a branch", branch `main`, folder `/` (or
`/docs`). Open it once and cut one clip from an uploaded file to confirm
the ffmpeg.wasm load works on Pages.
