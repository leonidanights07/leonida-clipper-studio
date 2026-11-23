// Leonida Clipper Studio — captions (pure, no DOM).
// Adapted from Leonida Clipper Pro Online (~/workspace/leonida-clipper-pro-web/app.js),
// which took the style colours from render_clips.py CAPTION_STYLES.
// Colours are #RRGGBB. buildAss() now also takes canvas size, an optional
// headline hook (top of frame) and an optional name/handle overlay.

export const SUBTITLE_STYLES = {
  hormozi: {
    label: "1 · Bold word-pop", font: "Arial Black", color: "#FFFFFF",
    highlight: "#FF0000", outlineColor: "#000000", wordsPerCue: 2,
    outline: 5, shadow: 2, background: "none", fontSize: 72, mode: "word",
    description: "Big bold words, 2 per cue, active word pops in colour. Loud and punchy.",
  },
  default: {
    label: "2 · White bold, black outline", font: "Arial Black", color: "#FFFFFF",
    highlight: "#FFFF00", outlineColor: "#000000", wordsPerCue: 3,
    outline: 5, shadow: 2, background: "none", fontSize: 64, mode: "word",
    description: "Classic white bold words, black outline, yellow active word, 3 per cue.",
  },
  karaoke: {
    label: "3 · Karaoke word-by-word", font: "Arial Black", color: "#FFFFFF",
    highlight: "#FFFF00", outlineColor: "#000000", wordsPerCue: 4,
    outline: 5, shadow: 2, background: "none", fontSize: 64, mode: "karaoke",
    description: "Word-by-word colour change as each word is spoken, karaoke style, 4 words per cue.",
  },
  minimal: {
    label: "4 · Minimal clean lower-third", font: "Arial", color: "#FFFFFF",
    highlight: "#D4EF83", outlineColor: "#000000", wordsPerCue: 5,
    outline: 8, shadow: 0, background: "box", backgroundColor: "#111111",
    backgroundOpacity: 65, fontSize: 54, mode: "word",
    description: "Lighter words on a dark lower-third box, 5 per cue. Quiet, stays out of the way.",
  },
  leonida: {
    label: "5 · Neon pink Leonida Nights", font: "Arial Black", color: "#FFFFFF",
    highlight: "#FF2E9A", outlineColor: "#000000", wordsPerCue: 3,
    outline: 5, shadow: 2, background: "box", backgroundColor: "#000000",
    backgroundOpacity: 60, fontSize: 64, mode: "word",
    description: "House style: white bold words, neon-pink active word, dark box. Bottom of the frame.",
  },
};

export const STYLE_ORDER = ["hormozi", "default", "karaoke", "minimal", "leonida"];
export const DEFAULT_STYLE = "leonida";

/** "00:01:23,456" or "00:01:23.456" -> seconds. */
export function parseCaptionTime(t) {
  const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, "0"), 10) / 1000;
}

/** Parse SRT or WebVTT text into [{start, end, text}]. */
export function parseSrt(text) {
  const cues = [];
  const clean = String(text).replace(/\r\n?/g, "\n").replace(/^WEBVTT[^\n]*\n/, "").trim();
  for (const block of clean.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^\d+$/.test(lines[0])) lines.shift();
    if (!lines.length) continue;
    const tm = lines[0].match(/^(.+?)\s*-->\s*(.+)$/);
    if (!tm) continue;
    const start = parseCaptionTime(tm[1]);
    const end = parseCaptionTime(tm[2]);
    if (start === null || end === null || end <= start) continue;
    const cueText = lines.slice(1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (cueText) cues.push({ start, end, text: cueText });
  }
  return cues;
}

/** Split a cue's text into words spread evenly across its time span. */
export function distributeWords(text, start, end) {
  const words = String(text).split(/\s+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) return [];
  const dur = Math.max(0.01, (end - start) / words.length);
  return words.map((word, i) => ({
    word,
    start: start + i * dur,
    end: start + (i + 1) * dur,
  }));
}

/** Timed words for one clip window, from whole-video cues. */
export function wordsForWindow(cues, winStart, winEnd) {
  const out = [];
  for (const cue of cues) {
    if (cue.end <= winStart || cue.start >= winEnd) continue;
    const s = Math.max(cue.start, winStart);
    const e = Math.min(cue.end, winEnd);
    for (const w of distributeWords(cue.text, s, e)) {
      out.push({ word: w.word, start: w.start - winStart, end: w.end - winStart });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** #RRGGBB -> ASS &HBBGGRR& (no alpha). */
export function assColor(hex) {
  const h = String(hex).replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/** #RRGGBB + opacity 0-100 -> ASS &HAABBGGRR& (AA: 00 opaque, FF transparent). */
export function assBackColor(hex, opacity) {
  const alpha = Math.round(255 * (1 - (opacity ?? 70) / 100));
  const h = String(hex).replace("#", "");
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

function escAss(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}");
}

// A long headline overflows a 1080-wide frame at 76px — wrap it into lines
// of at most ~18 chars at word boundaries (ASS line break is \N).
function splitHeadline(text, maxChars = 18) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join("\\N");
}

/**
 * Build an .ass subtitle file with word-by-word highlighting.
 * words: [{word, start, end}] in clip-relative seconds.
 * mode "word": one event per word, whole cue shown, active word coloured.
 * mode "karaoke": \k tags sweep the highlight across the cue as it is spoken.
 * opts: { width, height, headline, handle, duration }
 *   width/height — canvas size (PlayRes + font scaling; default 1080x1920).
 *   headline — big hook text shown at the top for the whole clip.
 *   handle — small name/handle shown bottom-left for the whole clip.
 *   duration — clip length in seconds (headline/handle span; default = last word end).
 */
export function buildAss(words, styleName, opts = {}) {
  const st = SUBTITLE_STYLES[styleName] || SUBTITLE_STYLES[DEFAULT_STYLE];
  const W = opts.width || 1080;
  const H = opts.height || 1920;
  // Fonts were tuned for 1080x1920; scale down for shorter canvases.
  const scale = Math.min(W / 1080, H / 1920);
  const fontSize = Math.max(18, Math.round(st.fontSize * scale));
  const marginV = Math.max(20, Math.round(180 * (H / 1920)));
  const borderStyle = st.background === "box" ? 3 : 1;
  const back = st.background === "box"
    ? assBackColor(st.backgroundColor || "#000000", st.backgroundOpacity ?? 60)
    : "&H00000000&";
  const duration = opts.duration || (words.length ? words[words.length - 1].end : 5);
  const headline = (opts.headline || "").trim();
  const handle = (opts.handle || "").trim();

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Leonida,${st.font},${fontSize},${assColor(st.color)},${assColor(st.highlight)},${assColor(st.outlineColor)},${back},-1,0,0,0,100,100,0,0,${borderStyle},${st.outline},${st.shadow},2,60,60,${marginV},1`,
    `Style: Headline,Arial Black,${Math.max(24, Math.round(76 * scale))},${assColor("#FFFFFF")},${assColor("#FF2E9A")},${assColor("#000000")},${assBackColor("#000000", 55)},-1,0,0,0,100,100,0,0,3,6,2,8,60,60,${Math.max(24, Math.round(48 * (H / 1920)))},1`,
    `Style: Handle,Arial,${Math.max(16, Math.round(40 * scale))},${assColor("#FFFFFF")},${assColor("#FF2E9A")},${assColor("#000000")},${assBackColor("#000000", 55)},-1,0,0,0,100,100,0,0,3,4,1,1,60,60,${Math.max(20, Math.round(36 * (H / 1920)))},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = [];
  if (headline) {
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Headline,,0,0,0,,${splitHeadline(escAss(headline))}`);
  }
  if (handle) {
    events.push(`Dialogue: 0,${assTime(0)},${assTime(duration)},Handle,,0,0,0,,${escAss(handle)}`);
  }
  const perCue = st.wordsPerCue || 3;
  for (let i = 0; i < words.length; i += perCue) {
    const cue = words.slice(i, i + perCue);
    if (st.mode === "karaoke") {
      const parts = cue.map((w) => {
        const cs = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${cs}}${escAss(w.word)}`;
      });
      events.push(`Dialogue: 0,${assTime(cue[0].start)},${assTime(cue[cue.length - 1].end)},Leonida,,0,0,0,,${parts.join(" ")}`);
    } else {
      for (let j = 0; j < cue.length; j++) {
        const w = cue[j];
        const shown = cue.map((cw, k) => {
          if (k === j) return `{\\c${assColor(st.highlight)}\\b1}${escAss(cw.word)}{\\c${assColor(st.color)}\\b0}`;
          return escAss(cw.word);
        }).join(" ");
        const end = j + 1 < cue.length ? cue[j + 1].start : w.end;
        events.push(`Dialogue: 0,${assTime(w.start)},${assTime(Math.max(end, w.start + 0.05))},Leonida,,0,0,0,,${shown}`);
      }
    }
  }
  return header.concat(events).join("\n") + "\n";
}
