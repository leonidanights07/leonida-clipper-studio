// Leonida Clipper Studio — Node tests (pure helpers only).
// Run: node tests.mjs
import {
  CANVAS_SIZES, LAYOUT_PRESETS, MAX_BOXES, presetLayout, snapCorner,
  clampBox, clampCrop, boxInsideCanvas, boxPixels, buildLayoutFilter, autoArrange,
} from "./layout.js";
import {
  SUBTITLE_STYLES, STYLE_ORDER, parseSrt, distributeWords,
  wordsForWindow, buildAss, assColor,
} from "./captions.js";

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// --- Layout: every preset x every canvas x single/two-video -----------------
console.log("layout presets");
for (const [key, size] of Object.entries(CANVAS_SIZES)) {
  for (const preset of Object.keys(LAYOUT_PRESETS)) {
    for (const hasSecond of [false, true]) {
      const boxes = presetLayout(preset, size.width, size.height, hasSecond);
      const allInside = boxes.every((b) => boxInsideCanvas(b));
      const noNaN = boxes.every((b) =>
        [b.x, b.y, b.w, b.h, b.crop.x, b.crop.y, b.crop.w, b.crop.h]
          .every((v) => Number.isFinite(v)));
      const cropsOk = boxes.every((b) =>
        b.crop.x >= 0 && b.crop.y >= 0 &&
        b.crop.x + b.crop.w <= 1.0001 && b.crop.y + b.crop.h <= 1.0001);
      const sourcesOk = hasSecond
        ? boxes.some((b) => b.source === "second")
        : boxes.every((b) => b.source === "main");
      check(
        `${preset} on ${key} ${hasSecond ? "two-video" : "single-video"}: boxes inside canvas, valid crops, right sources`,
        allInside && noNaN && cropsOk && sourcesOk,
        JSON.stringify(boxes),
      );
      // Filter graph builds and ends in [v], with even pixel sizes.
      const { filter, inputs } = buildLayoutFilter(boxes, size, 60);
      check(
        `${preset} on ${key}: filter graph valid`,
        filter.includes("[v]") && filter.includes("nullsrc") &&
          (hasSecond ? inputs.length === 2 : inputs.length === 1) &&
          !/NaN|undefined/.test(filter),
        filter,
      );
      const px = boxes.map((b) => boxPixels(b, size.width, size.height));
      check(
        `${preset} on ${key}: box pixels even and inside canvas`,
        px.every((p) => p.w % 2 === 0 && p.h % 2 === 0 &&
          p.x >= 0 && p.y >= 0 && p.x + p.w <= size.width && p.y + p.h <= size.height),
        JSON.stringify(px),
      );
    }
  }
}

// --- Layout: corner snapping -------------------------------------------------
console.log("corner snapping");
for (const [key, size] of Object.entries(CANVAS_SIZES)) {
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const boxes = presetLayout("game-facecam", size.width, size.height, false);
    const snapped = snapCorner(boxes, size.width, size.height, corner);
    const b = snapped[1];
    const ok = boxInsideCanvas(b) &&
      (corner.includes("top") ? b.y <= 0.031 : b.y + b.h >= 0.969) &&
      (corner.includes("left") ? b.x <= 0.031 : b.x + b.w >= 0.969);
    check(`game-facecam ${corner} on ${key}`, ok, JSON.stringify(b));
  }
}

// --- Layout: presets carry the track flag (off by default) ------------------
console.log("track flag");
check("preset boxes all start with track off",
  Object.keys(LAYOUT_PRESETS).every((p) =>
    presetLayout(p, 1080, 1920, false).every((b) => b.track === false)));
check("MAX_BOXES is 4", MAX_BOXES === 4);

// --- Layout: auto-arrange grid ----------------------------------------------
console.log("auto-arrange");
function boxesOverlap(a, b) {
  return a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 &&
    a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
}
for (const [key, size] of Object.entries(CANVAS_SIZES)) {
  for (const n of [1, 2, 3, 4]) {
    for (const hasSecond of [false, true]) {
      const seed = Array.from({ length: n }, (_, i) => ({
        source: "main", x: 0, y: 0, w: 1, h: 1,
        crop: { x: 0, y: 0, w: 1, h: 1 }, track: i === 0,
      }));
      const arranged = autoArrange(seed, size.width, size.height, hasSecond);
      const inside = arranged.every((b) => boxInsideCanvas(b));
      const noOverlap = arranged.every((a, i) =>
        arranged.every((b, j) => i >= j || !boxesOverlap(a, b)));
      const cropsOk = arranged.every((b) =>
        b.crop.x >= 0 && b.crop.y >= 0 &&
        b.crop.x + b.crop.w <= 1.0001 && b.crop.y + b.crop.h <= 1.0001);
      const keptFlags = arranged.every((b, i) => b.track === (i === 0));
      const keptCount = arranged.length === n;
      check(`autoArrange ${n} boxes on ${key} ${hasSecond ? "two-video" : "single-video"}: inside, no overlap, valid crops, flags kept`,
        inside && noOverlap && cropsOk && keptFlags && keptCount,
        JSON.stringify(arranged));
      const { filter } = buildLayoutFilter(arranged, size, 30);
      check(`autoArrange ${n} on ${key}: filter graph valid`,
        filter.includes("[v]") && !/NaN|undefined/.test(filter));
    }
  }
}
check("autoArrange keeps a hand-set crop instead of overwriting it",
  (() => {
    const seed = [
      { source: "main", x: 0, y: 0, w: 1, h: 1, crop: { x: 0.2, y: 0.1, w: 0.3, h: 0.3 }, track: false },
      { source: "main", x: 0, y: 0, w: 1, h: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, track: false },
    ];
    const out = autoArrange(seed, 1080, 1920, false);
    return out[0].crop.x === 0.2 && out[0].crop.w === 0.3 &&
      out[1].crop.x === 0.5 && out[1].crop.w === 0.5; // untouched box 1 got the half crop
  })());

// --- Layout: tracked filter graph -------------------------------------------
console.log("tracked filter");
{
  const boxes = presetLayout("game-facecam", 1080, 1920, false);
  boxes[1].track = true;
  const { filter } = buildLayoutFilter(boxes, { width: 1080, height: 1920 }, 60, { 1: "track1.txt" });
  check("tracked box gets sendcmd + named crop, untracked box stays plain",
    filter.includes("sendcmd=f=track1.txt") && filter.includes("crop@trk1=") &&
      !filter.includes("crop@trk0=") && filter.includes("[0:v]crop="));
  const { filter: plain } = buildLayoutFilter(boxes, { width: 1080, height: 1920 }, 60);
  check("no track files means no sendcmd anywhere", !plain.includes("sendcmd"));
}

// --- Layout: clamping --------------------------------------------------------
console.log("clamping");
check("clampBox pulls an out-of-bounds box back inside",
  (() => {
    const b = clampBox({ x: -0.5, y: 0.9, w: 2, h: 0.01, source: "main", crop: { x: 0, y: 0, w: 1, h: 1 } });
    return boxInsideCanvas(b) && b.x === 0 && b.y <= 1 - b.h;
  })());
check("clampBox enforces the minimum size",
  (() => {
    const b = clampBox({ x: 0.1, y: 0.1, w: 0.001, h: 0.001, source: "main", crop: { x: 0, y: 0, w: 1, h: 1 } });
    return b.w >= 0.05 && b.h >= 0.05;
  })());
check("clampCrop keeps a region inside its source",
  (() => {
    const c = clampCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
    return c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001 && c.w >= 0.05;
  })());
check("boxInsideCanvas rejects a box hanging off the edge",
  !boxInsideCanvas({ x: 0.8, y: 0.8, w: 0.4, h: 0.4 }));

// --- Captions: SRT parsing / word timing ------------------------------------
console.log("captions");
const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world this is a test

2
00:00:04.500 --> 00:00:06,000
Second cue here
`;
const cues = parseSrt(SRT);
check("parseSrt reads 2 cues with times", cues.length === 2 &&
  Math.abs(cues[0].start - 1) < 0.001 && Math.abs(cues[1].start - 4.5) < 0.001);
check("parseSrt handles WebVTT headers",
  parseSrt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n").length === 1);
const words = wordsForWindow(cues, 0, 6);
check("wordsForWindow spreads words across the window",
  words.length === 9 && words[0].start >= 1 && words[words.length - 1].end <= 6);
check("distributeWords on empty text gives no words",
  distributeWords("   ", 0, 1).length === 0);
check("assColor converts #FF2E9A to ASS BGR", assColor("#FF2E9A") === "&H9A2EFF&");

// --- Captions: ASS for all 5 styles x 3 canvas sizes -------------------------
console.log("ASS generation");
const sampleWords = [
  { word: "Welcome", start: 0.0, end: 0.4 },
  { word: "to", start: 0.4, end: 0.6 },
  { word: "Leonida", start: 0.6, end: 1.1 },
  { word: "Nights", start: 1.1, end: 1.6 },
  { word: "tonight", start: 1.6, end: 2.1 },
];
for (const style of STYLE_ORDER) {
  for (const [key, size] of Object.entries(CANVAS_SIZES)) {
    const ass = buildAss(sampleWords, style, {
      width: size.width, height: size.height,
      headline: "YOU WON'T BELIEVE THIS", handle: "@LeonidaNights07", duration: 60,
    });
    const hasRes = ass.includes(`PlayResX: ${size.width}`) && ass.includes(`PlayResY: ${size.height}`);
    const hasDialogue = ass.includes("Dialogue:");
    const hasHeadline = ass.includes("Headline,,0,0,0,,YOU WON'T BELIEVE\\NTHIS");
    const hasHandle = ass.includes("Handle,,0,0,0,,@LeonidaNights07");
    const styleDef = ass.includes(`Style: Leonida,${SUBTITLE_STYLES[style].font},`);
    check(`buildAss ${style} on ${key}: res, styles, dialogue, headline, handle`,
      hasRes && hasDialogue && hasHeadline && hasHandle && styleDef);
  }
}
check("buildAss with no words and no text still yields a valid header",
  buildAss([], "leonida").includes("[Script Info]"));
check("buildAss karaoke uses \\k tags",
  buildAss(sampleWords, "karaoke").includes("\\k"));
check("buildAss unknown style falls back to leonida",
  buildAss(sampleWords, "nope").includes("Style: Leonida,Arial Black,64,"));
check("buildAss wraps a long headline across lines instead of overflowing",
  buildAss(sampleWords, "leonida", { headline: "YOU WON'T BELIEVE THIS", duration: 5 })
    .includes("Headline,,0,0,0,,YOU WON'T BELIEVE\\NTHIS"));
check("buildLayoutFilter output ends in [v] exactly once (ass splices in before it)",
  (() => {
    const { filter } = buildLayoutFilter(presetLayout("game-facecam", 1080, 1920, false), { width: 1080, height: 1920 }, 60);
    return (filter.match(/\[v\]/g) || []).length === 1 && filter.endsWith("[v]") &&
      filter.replace(/\[v\]$/, ",ass=subs.ass[v]").includes(",ass=subs.ass[v]");
  })());

// --- Summary -----------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
