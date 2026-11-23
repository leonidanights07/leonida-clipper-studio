// Leonida Clipper Studio — two-box layout math (pure, no DOM).
// Boxes are stored in normalised canvas coordinates (0..1) so the same
// layout works for every canvas size. A box is:
//   { source: "main" | "second",          // which uploaded video it shows
//     x, y, w, h,                          // position/size on the canvas (0..1)
//     crop: { x, y, w, h },                // region of the source video it shows (0..1)
//     track: false }                       // true = crop follows a detected face (export-time)
//
// Face tracking is per-box: a tracked box gets a moving crop (see
// buildLayoutFilter's trackFiles), an untracked box keeps a static crop.

export const MAX_BOXES = 4;

export const CANVAS_SIZES = {
  "9:16": { label: "9:16 · Vertical · 1080 × 1920", width: 1080, height: 1920 },
  "1:1": { label: "1:1 · Square · 1080 × 1080", width: 1080, height: 1080 },
  "16:9": { label: "16:9 · Widescreen · 1920 × 1080", width: 1920, height: 1080 },
};

export const LAYOUT_PRESETS = {
  "game-facecam": {
    label: "Game + facecam",
    description: "Game full-bleed, facecam box on top — drag it anywhere, or snap it to a corner.",
  },
  split: {
    label: "Split 50/50 — podcast",
    description: "Two speakers, one on top, one below. Each box is half the canvas.",
  },
  "game-strip": {
    label: "Game on top + strip",
    description: "Game on top (~70%), facecam strip along the bottom (~30%).",
  },
  pip: {
    label: "Picture-in-picture",
    description: "Game full-bleed, small facecam box bottom-right.",
  },
};

export const FACE_CAM_CORNERS = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};

const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
// Default facecam region when one video feeds both boxes: top-right quarter,
// where stream facecams usually sit. The user can drag it anywhere.
const FACE_CAM_CROP = { x: 0.5, y: 0, w: 0.5, h: 0.5 };

function facecamBox(canvasW, canvasH, corner, widthFrac) {
  const a = canvasW / canvasH; // canvas aspect
  // Facecam box keeps a 16:9 aspect: h = w * (W/H) * 9/16 in normalised units.
  const w = widthFrac;
  const h = w * a * (9 / 16);
  const m = 0.03; // margin from the edge
  const pos = {
    "top-left": { x: m, y: m },
    "top-right": { x: 1 - w - m, y: m },
    "bottom-left": { x: m, y: 1 - h - m },
    "bottom-right": { x: 1 - w - m, y: 1 - h - m },
  }[corner] || { x: 1 - w - m, y: 1 - h - m };
  return { x: pos.x, y: pos.y, w, h };
}

/**
 * Boxes for a preset on a canvas.
 * hasSecond: true when a second video file was uploaded — box B then shows
 * the second video full-frame; otherwise both boxes crop regions of the
 * same (main) video.
 * corner: facecam corner for the game-facecam / pip presets.
 */
export function presetLayout(preset, canvasW, canvasH, hasSecond = false, corner = "bottom-right") {
  const cropB = hasSecond ? { ...FULL_CROP } : { ...FACE_CAM_CROP };
  const full = { source: "main", x: 0, y: 0, w: 1, h: 1, crop: { ...FULL_CROP }, track: false };
  switch (preset) {
    case "game-facecam": {
      const b = facecamBox(canvasW, canvasH, corner, 0.3);
      return [
        { ...full },
        { source: hasSecond ? "second" : "main", ...b, crop: cropB, track: false },
      ];
    }
    case "split": {
      const cropA = hasSecond ? { ...FULL_CROP } : { x: 0, y: 0, w: 0.5, h: 1 };
      const cropB2 = hasSecond ? { ...FULL_CROP } : { x: 0.5, y: 0, w: 0.5, h: 1 };
      return [
        { source: "main", x: 0, y: 0, w: 1, h: 0.5, crop: cropA, track: false },
        { source: hasSecond ? "second" : "main", x: 0, y: 0.5, w: 1, h: 0.5, crop: cropB2, track: false },
      ];
    }
    case "game-strip": {
      return [
        { ...full, h: 0.68 },
        { source: hasSecond ? "second" : "main", x: 0, y: 0.68, w: 1, h: 0.32, crop: cropB, track: false },
      ];
    }
    case "pip": {
      const b = facecamBox(canvasW, canvasH, "bottom-right", 0.22);
      return [
        { ...full },
        { source: hasSecond ? "second" : "main", ...b, crop: cropB, track: false },
      ];
    }
    default:
      return [{ ...full }];
  }
}

/** Snap a facecam box (boxes[1]) to a corner of the canvas. */
export function snapCorner(boxes, canvasW, canvasH, corner) {
  if (!boxes || boxes.length < 2) return boxes;
  const b = facecamBox(canvasW, canvasH, corner, boxes[1].w);
  const out = boxes.map((box) => ({ ...box, crop: { ...box.crop } }));
  out[1].x = b.x;
  out[1].y = b.y;
  out[1].h = b.h;
  return out;
}

const MIN_SIZE = 0.05;

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Keep one box inside the canvas: clamp position/size, enforce a minimum size. */
export function clampBox(box) {
  const b = { ...box, crop: { ...box.crop } };
  b.w = Math.min(1, Math.max(MIN_SIZE, b.w));
  b.h = Math.min(1, Math.max(MIN_SIZE, b.h));
  b.x = Math.min(1 - b.w, Math.max(0, b.x));
  b.y = Math.min(1 - b.h, Math.max(0, b.y));
  b.x = round4(b.x); b.y = round4(b.y); b.w = round4(b.w); b.h = round4(b.h);
  return b;
}

/** Keep a crop region inside its source video (0..1), minimum size 0.05. */
export function clampCrop(crop) {
  const c = { ...crop };
  c.w = Math.min(1, Math.max(MIN_SIZE, c.w));
  c.h = Math.min(1, Math.max(MIN_SIZE, c.h));
  c.x = Math.min(1 - c.w, Math.max(0, c.x));
  c.y = Math.min(1 - c.h, Math.max(0, c.y));
  c.x = round4(c.x); c.y = round4(c.y); c.w = round4(c.w); c.h = round4(c.h);
  return c;
}

/** True when a box sits fully inside the canvas (with a tiny epsilon). */
export function boxInsideCanvas(box, eps = 1e-6) {
  return (
    Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.w) && Number.isFinite(box.h) &&
    box.x >= -eps && box.y >= -eps &&
    box.w >= MIN_SIZE && box.h >= MIN_SIZE &&
    box.x + box.w <= 1 + eps && box.y + box.h <= 1 + eps
  );
}

function even(n) {
  return 2 * Math.round(n / 2);
}

/** Box position/size in output pixels (even numbers, safe for yuv420p). */
export function boxPixels(box, canvasW, canvasH) {
  const x = even(box.x * canvasW);
  const y = even(box.y * canvasH);
  let w = Math.max(2, even(box.w * canvasW));
  let h = Math.max(2, even(box.h * canvasH));
  // Even-rounding can push a box 2px past the edge; pull it back in.
  // (canvasW - x is even because both are even, so w stays even.)
  if (x + w > canvasW) w = Math.max(2, canvasW - x);
  if (y + h > canvasH) h = Math.max(2, canvasH - y);
  return { x, y, w, h };
}

/**
 * Auto-arrange the current boxes into a grid (for 3–4 person podcasts).
 * Positions/sizes come from the grid; each box keeps its own source and
 * track flag. Crops are only filled in when a box still shows the full
 * frame — a crop the user already set by hand is left alone.
 *   1 box: full canvas. 2: top/bottom halves. 3: two on top, one full-width
 *   below. 4: 2×2 grid.
 * Single-video grid cells get quadrant crops (top-left, top-right,
 * bottom-left, bottom-right) so each box shows a different person; with a
 * second video, boxes alternate main/second full-frame.
 */
const GRID_CELLS = {
  1: [{ x: 0, y: 0, w: 1, h: 1 }],
  2: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }],
  3: [
    { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 1, h: 0.5 },
  ],
  4: [
    { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
};
const QUADRANT_CROPS = [
  { x: 0, y: 0, w: 0.5, h: 0.5 },
  { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
];

function isFullCrop(crop) {
  return crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
}

export function autoArrange(boxes, canvasW, canvasH, hasSecond = false) {
  const n = Math.min(MAX_BOXES, Math.max(1, boxes.length));
  const cells = GRID_CELLS[n];
  return boxes.slice(0, n).map((box, i) => {
    const cell = cells[i];
    const out = { ...box, crop: { ...box.crop }, x: cell.x, y: cell.y, w: cell.w, h: cell.h };
    if (isFullCrop(box.crop)) {
      if (hasSecond) {
        out.source = i % 2 === 0 ? "main" : "second";
        out.crop = { ...FULL_CROP };
      } else if (n === 2) {
        // Two speakers in one frame: left half / right half.
        out.crop = i === 0 ? { x: 0, y: 0, w: 0.5, h: 1 } : { x: 0.5, y: 0, w: 0.5, h: 1 };
      } else if (n > 2) {
        out.crop = { ...QUADRANT_CROPS[i] };
      }
    }
    return clampBox(out);
  });
}

/**
 * Build the ffmpeg filter_complex for the two-box layout.
 * boxes: [{source, x, y, w, h, crop, track}] in normalised coords.
 * canvas: {width, height}. duration: clip length in seconds (for nullsrc).
 * trackFiles: {boxIndex: filename} for boxes with face tracking ON — each
 *   file is an ffmpeg sendcmd script that moves that box's crop as the face
 *   moves (one command per sample time). Untracked boxes keep a static crop.
 * Returns { filter, inputs: ["main"] | ["main", "second"] }.
 * Input 0 is the main video, input 1 (when used) is the second video.
 * The graph ends with [v]. To burn captions in, replace the trailing [v]
 * with ",ass=subs.ass[v]" — do NOT append ",ass=..." after [v].
 */
export function buildLayoutFilter(boxes, canvas, duration, trackFiles = {}) {
  const { width: W, height: H } = canvas;
  const usesSecond = boxes.some((b) => b.source === "second");
  const parts = [];
  const overlays = [];
  boxes.forEach((box, i) => {
    const srcIdx = box.source === "second" ? 1 : 0;
    const px = boxPixels(box, W, H);
    const c = box.crop;
    // crop expressions use trunc(.../2)*2 so every value stays even for yuv420p.
    const cropExpr = `'trunc(iw*${c.w}/2)*2':'trunc(ih*${c.h}/2)*2':'trunc(iw*${c.x}/2)*2':'trunc(ih*${c.y}/2)*2'`;
    const cmdFile = trackFiles[i];
    if (cmdFile) {
      // Tracked box: sendcmd drives this crop instance's x/y over time.
      // The crop instance is named (crop@trk<i>) so commands hit only it.
      parts.push(
        `[${srcIdx}:v]sendcmd=f=${cmdFile},crop@trk${i}=${cropExpr},scale=${px.w}:${px.h},setsar=1[box${i}]`,
      );
    } else {
      parts.push(
        `[${srcIdx}:v]crop=${cropExpr},scale=${px.w}:${px.h},setsar=1[box${i}]`,
      );
    }
    overlays.push({ i, x: px.x, y: px.y });
  });
  const dur = Math.max(0.1, duration || 1);
  parts.push(`nullsrc=size=${W}x${H}:duration=${dur}[base]`);
  let current = "base";
  overlays.forEach((o, k) => {
    const last = k === overlays.length - 1;
    const out = last ? "v" : `tmp${k}`;
    parts.push(`[${current}][box${o.i}]overlay=${o.x}:${o.y}[${out}]`);
    current = out;
  });
  return {
    filter: parts.join(";"),
    inputs: usesSecond ? ["main", "second"] : ["main"],
  };
}
