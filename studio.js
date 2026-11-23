// Leonida Clipper Studio — manual two-box clip editor.
// Static site: no server, no API key, no account, files never leave the device.
// Video cutting runs in the browser with ffmpeg.wasm (same proven pattern as
// Leonida Clipper Pro Online). Pure helpers live in layout.js / captions.js
// and are unit-tested in Node (tests.mjs); this file is the browser UI.
import {
  CANVAS_SIZES, LAYOUT_PRESETS, FACE_CAM_CORNERS, MAX_BOXES,
  presetLayout, snapCorner, clampBox, clampCrop, buildLayoutFilter, autoArrange,
} from "./layout.js";
import {
  SUBTITLE_STYLES, STYLE_ORDER, DEFAULT_STYLE,
  parseSrt, distributeWords, wordsForWindow, buildAss,
} from "./captions.js";

const FFMPEG_ESM = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
const FFMPEG_UTIL_ESM = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const FFMPEG_WORKER_URL = new URL("vendor/ffmpeg/worker.js", import.meta.url).toString();

// Face detection (MediaPipe Tasks Vision, in-browser only, loaded lazily and
// only when a box has "Track face" on). Verified reachable 2026-11-23.
const MEDIAPIPE_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const MEDIAPIPE_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

export function formatTime(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  // ---------------------------------------------------------------- state --
  let mainFile = null, secondFile = null;
  let mainUrl = null, secondUrl = null;
  let mainMeta = null;   // {width, height, duration}
  let secondMeta = null;
  let mode = "game";     // "game" | "podcast" — changes default layouts + box labels only
  let canvasKey = "9:16";
  let preset = "game-facecam";
  let corner = "bottom-right";
  let boxes = presetLayout(preset, 1080, 1920, false, corner);
  let selectedBox = 1;
  let inPoint = 0, outPoint = 60;
  let playhead = 0;
  let syncOffset = 0;    // seconds, second video shifted by this much
  let headline = "", handle = "";
  let style = DEFAULT_STYLE;
  let captionText = "", captionDirty = false;
  let uploadedCues = [], embeddedCues = [];
  let ffmpeg = null, ffmpegUtil = null, running = false, inputsWritten = false;
  let waveformData = null;

  const canvas = () => CANVAS_SIZES[canvasKey];
  const clipLen = () => Math.max(0.1, outPoint - inPoint);
  // Box labels follow the mode: game = GAME + facecam(s), podcast = speakers.
  const labelFor = (i) => mode === "podcast"
    ? `SPK ${i + 1}`
    : (i === 0 ? "GAME" : (i === 1 ? "CAM" : `CAM ${i}`));
  const boxLabelText = (box, i) =>
    `${labelFor(i)} · ${box.source === "second" ? "2nd video" : "main video"}${box.track ? " · TRACK" : ""}`;

  function setStatus(html) { $("status").innerHTML = html; }
  function setProgress(frac) {
    const wrap = $("progressWrap"), bar = $("progressBar");
    if (!wrap || !bar) return;
    wrap.classList.add("show");
    bar.style.width = `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`;
  }
  function log(msg) {
    const el = $("log");
    el.classList.add("show");
    el.textContent += `${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }

  // ------------------------------------------------------------ ffmpeg load --
  async function loadCutter() {
    if (ffmpeg) return ffmpeg;
    setStatus("Loading the video cutter for the first time (about 30 MB) — this can take a minute on a slow connection…");
    const ffmpegMod = await import(FFMPEG_ESM);
    ffmpegUtil = await import(FFMPEG_UTIL_ESM);
    ffmpeg = new ffmpegMod.FFmpeg();
    ffmpeg.on("log", ({ message }) => log(message));
    await ffmpeg.load({
      classWorkerURL: FFMPEG_WORKER_URL,
      coreURL: await ffmpegUtil.toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await ffmpegUtil.toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    return ffmpeg;
  }

  async function extractEmbeddedCues(ff, inputName) {
    try {
      await ff.exec(["-i", inputName, "-map", "0:s:0", "-f", "srt", "-y", "subs.srt"]);
      const data = await ff.readFile("subs.srt");
      const text = new TextDecoder().decode(data);
      await ff.deleteFile("subs.srt");
      return parseSrt(text);
    } catch (e) { return []; }
  }

  // ------------------------------------------------------------- file picks --
  function pickMain(file) {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name)) {
      setStatus("That doesn't look like a video file. Please choose a video (MP4, WebM, MOV…).");
      return;
    }
    mainFile = file;
    if (mainUrl) URL.revokeObjectURL(mainUrl);
    mainUrl = URL.createObjectURL(file);
    $("mainVideo").src = mainUrl;
    $("cropVideo").src = mainUrl;
    $("fileInfo").textContent = `✓ ${file.name} · ${formatSize(file.size)} — reading length…`;
    const probe = $("mainVideo");
    probe.onloadedmetadata = () => {
      mainMeta = { width: probe.videoWidth, height: probe.videoHeight, duration: probe.duration || 0 };
      inPoint = 0;
      outPoint = Math.min(60, mainMeta.duration || 60);
      playhead = 0;
      $("fileInfo").textContent = `✓ ${file.name} · ${formatSize(file.size)} · ${formatTime(mainMeta.duration)} · ${mainMeta.width}×${mainMeta.height}`;
      setStatus(`<b>${escapeHtml(file.name)}</b> loaded. Arrange the boxes, set In and Out on the timeline, then export.`);
      applyLayout();
      buildTimeline();
      updateLengthReadout();
    };
    probe.onerror = () => setStatus("I couldn't read that video file. Try a different file (MP4 works best).");
  }

  function pickSecond(file) {
    if (!file) return;
    secondFile = file;
    if (secondUrl) URL.revokeObjectURL(secondUrl);
    secondUrl = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.src = secondUrl;
    probe.onloadedmetadata = () => {
      secondMeta = { width: probe.videoWidth, height: probe.videoHeight, duration: probe.duration || 0 };
      URL.revokeObjectURL(probe.src);
      $("secondInfo").textContent = `✓ ${file.name} · ${formatSize(file.size)} · ${formatTime(secondMeta.duration)}`;
      applyLayout();
      setStatus("Second video loaded — box B now shows it. Use the sync slider if the two videos drift apart.");
    };
    probe.onerror = () => {
      URL.revokeObjectURL(probe.src);
      setStatus("I couldn't read that second video file. Try a different file.");
    };
  }

  function clearSecond() {
    secondFile = null;
    secondMeta = null;
    if (secondUrl) URL.revokeObjectURL(secondUrl);
    secondUrl = null;
    $("secondInput").value = "";
    $("secondInfo").textContent = "";
    $("syncRow").style.display = "none";
    applyLayout();
  }

  // ---------------------------------------------------------------- layout --
  function setMode(nextMode) {
    if (nextMode === mode) return;
    mode = nextMode;
    // The mode only changes the default layout + labels — the box engine
    // is the same. Switching resets to that mode's default 2-box layout.
    preset = mode === "podcast" ? "split" : "game-facecam";
    document.querySelectorAll("#modeToggle .pill").forEach((el) =>
      el.classList.toggle("selected", el.dataset.mode === mode));
    document.querySelectorAll("#presetPills .pill").forEach((el) =>
      el.classList.toggle("selected", el.dataset.preset === preset));
    $("cornerRow").style.display = (preset === "game-facecam") ? "" : "none";
    $("modeHint").textContent = mode === "podcast"
      ? "Podcast mode: speaker-split layouts by default, boxes labelled SPK 1, SPK 2… — add up to 4 speakers."
      : "Game mode: game + facecam layouts by default, boxes labelled GAME and CAM.";
    applyLayout();
    setStatus(mode === "podcast"
      ? "Podcast mode — default layout is the 50/50 speaker split. Add boxes for more speakers, or pick another layout below."
      : "Game mode — default layout is game full-bleed with a facecam box.");
  }

  function applyLayout() {
    const c = canvas();
    boxes = presetLayout(preset, c.width, c.height, !!secondFile, corner);
    selectedBox = boxes.length > 1 ? 1 : 0;
    renderBoxes();
    renderBoxList();
    renderCropEditor();
    $("syncRow").style.display = secondFile ? "" : "none";
  }

  function renderBoxes() {
    const stage = $("stage");
    const c = canvas();
    stage.style.aspectRatio = `${c.width} / ${c.height}`;
    // Keep the stage a sensible on-screen size for tall canvases.
    stage.style.maxHeight = "560px";
    stage.querySelectorAll(".box").forEach((el) => el.remove());
    boxes.forEach((box, i) => {
      const el = document.createElement("div");
      el.className = "box" + (i === selectedBox ? " selected" : "") + (box.track ? " tracked" : "");
      el.dataset.box = i;
      // Live video inside the box: the inner <video> is scaled and shifted so
      // the visible part is exactly this box's crop region — a true preview
      // of what the export will show (crop, then stretch to the box size).
      const srcUrl = box.source === "second" ? secondUrl : mainUrl;
      if (srcUrl) {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        v.src = srcUrl;
        v.className = "box-video";
        el.appendChild(v);
      }
      el.insertAdjacentHTML("beforeend",
        `<span class="box-label">${escapeHtml(boxLabelText(box, i))}</span>` +
        `<span class="box-handle" data-resize="${i}" title="Drag to resize"></span>`);
      el.addEventListener("pointerdown", (e) => {
        if (e.target.dataset.resize !== undefined) return;
        selectBox(i);
        startBoxDrag(e, i, "move");
      });
      el.querySelector(".box-handle").addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        selectBox(i);
        startBoxDrag(e, i, "resize");
      });
      stage.appendChild(el);
    });
    layoutBoxEls();
    syncPreviewVideos();
    renderHeadlinePreview();
  }

  // Cheap style-only update (used while dragging — no DOM rebuild, so the
  // preview videos keep playing instead of reloading on every mousemove).
  function layoutBoxEls() {
    const stage = $("stage");
    const boxEls = stage.querySelectorAll(".box");
    boxes.forEach((box, i) => {
      const el = boxEls[i];
      if (!el) return;
      el.style.left = `${box.x * 100}%`;
      el.style.top = `${box.y * 100}%`;
      el.style.width = `${box.w * 100}%`;
      el.style.height = `${box.h * 100}%`;
      el.classList.toggle("selected", i === selectedBox);
      el.classList.toggle("tracked", !!box.track);
      const v = el.querySelector(".box-video");
      if (v) {
        v.style.left = `${-(box.crop.x / box.crop.w) * 100}%`;
        v.style.top = `${-(box.crop.y / box.crop.h) * 100}%`;
        v.style.width = `${100 / box.crop.w}%`;
        v.style.height = `${100 / box.crop.h}%`;
      }
      const label = el.querySelector(".box-label");
      if (label) label.textContent = boxLabelText(box, i);
    });
    $("boxInfo").textContent =
      boxes.map((b, i) =>
        `Box ${i + 1} (${labelFor(i)}): ${Math.round(b.x * 100)}%, ${Math.round(b.y * 100)}% · ${Math.round(b.w * 100)}% × ${Math.round(b.h * 100)}% of the frame · ${b.source === "second" ? "2nd video" : "main video"}${b.track ? " · face tracking ON" : ""}`).join("  ·  ");
  }

  // ------------------------------------------------------------ boxes panel --
  // One row per box: pick it, change its video, turn face tracking on/off,
  // or remove it. The row and the stage box stay in sync.
  function renderBoxList() {
    const list = $("boxList");
    list.innerHTML = "";
    boxes.forEach((box, i) => {
      const row = document.createElement("div");
      row.className = "box-row" + (i === selectedBox ? " selected" : "");
      row.innerHTML =
        `<button type="button" class="box-row-pick" data-pick="${i}"><b>${escapeHtml(labelFor(i))}</b></button>` +
        `<select data-src="${i}" aria-label="Video for ${escapeHtml(labelFor(i))}">` +
        `<option value="main"${box.source === "main" ? " selected" : ""}>Main video</option>` +
        `<option value="second"${box.source === "second" ? " selected" : ""}${secondFile ? "" : " disabled"}>2nd video</option>` +
        `</select>` +
        `<label class="track-toggle" title="When on, this box's crop follows the detected face during export"><input type="checkbox" data-track="${i}"${box.track ? " checked" : ""}> Track face</label>` +
        `<button type="button" class="box-row-remove" data-remove="${i}" ${boxes.length <= 1 ? "disabled" : ""} title="Remove this box">✕</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => selectBox(parseInt(b.dataset.pick, 10))));
    list.querySelectorAll("[data-src]").forEach((sel) =>
      sel.addEventListener("change", () => {
        boxes[parseInt(sel.dataset.src, 10)].source = sel.value;
        renderBoxes();
        renderBoxList();
      }));
    list.querySelectorAll("[data-track]").forEach((cb) =>
      cb.addEventListener("change", () => {
        boxes[parseInt(cb.dataset.track, 10)].track = cb.checked;
        layoutBoxEls();
        renderBoxList();
      }));
    list.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => removeBox(parseInt(b.dataset.remove, 10))));
    $("addBoxBtn").disabled = boxes.length >= MAX_BOXES;
    $("addBoxBtn").textContent = boxes.length >= MAX_BOXES
      ? `Add box — ${MAX_BOXES} max` : "＋ Add box";
    $("boxCount").textContent = `${boxes.length} of ${MAX_BOXES} boxes`;
  }

  function addBox() {
    if (boxes.length >= MAX_BOXES) {
      setStatus(`That's the limit for v1 — ${MAX_BOXES} boxes.`);
      return;
    }
    const c = canvas();
    const a = c.width / c.height;
    const w = 0.32;
    const h = w * a * (9 / 16);
    const k = boxes.length;
    const nb = {
      source: "main",
      x: Math.min(0.64, 0.05 + 0.08 * k),
      y: Math.min(1 - h - 0.03, 0.05 + 0.08 * k),
      w, h,
      crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      track: false,
    };
    boxes.push(clampBox(nb));
    selectedBox = boxes.length - 1;
    renderBoxes();
    renderBoxList();
    renderCropEditor();
    setStatus(`Box ${boxes.length} (${labelFor(boxes.length - 1)}) added — drag it where you want it, pick its video and crop region.`);
  }

  function removeBox(i) {
    if (boxes.length <= 1) return;
    boxes.splice(i, 1);
    selectedBox = Math.min(selectedBox, boxes.length - 1);
    renderBoxes();
    renderBoxList();
    renderCropEditor();
  }

  function autoArrangeBoxes() {
    boxes = autoArrange(boxes, canvas().width, canvas().height, !!secondFile);
    selectedBox = Math.min(selectedBox, boxes.length - 1);
    renderBoxes();
    renderBoxList();
    renderCropEditor();
    setStatus(`Auto-arranged ${boxes.length} box${boxes.length === 1 ? "" : "es"} into a grid — drag any box to fine-tune it.`);
  }

  // Keep the little videos inside the boxes in step with the main preview.
  function syncPreviewVideos() {
    const main = $("mainVideo");
    document.querySelectorAll(".box-video").forEach((v) => {
      if (Math.abs(v.currentTime - main.currentTime) > 0.3) {
        try { v.currentTime = main.currentTime; } catch (e) { /* not ready yet */ }
      }
      if (main.paused) { v.pause(); } else { v.play().catch(() => {}); }
    });
  }

  function selectBox(i) {
    selectedBox = i;
    layoutBoxEls();
    renderBoxList();
    renderCropEditor();
  }

  function startBoxDrag(startEvent, index, mode) {
    const stage = $("stage");
    const rect = stage.getBoundingClientRect();
    const startX = startEvent.clientX, startY = startEvent.clientY;
    const orig = { ...boxes[index] };
    const move = (e) => {
      const dx = (e.clientX - startX) / rect.width;
      const dy = (e.clientY - startY) / rect.height;
      const b = { ...orig };
      if (mode === "move") { b.x = orig.x + dx; b.y = orig.y + dy; }
      else { b.w = orig.w + dx; b.h = orig.h + dy; }
      boxes[index] = clampBox(b);
      layoutBoxEls();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    startEvent.preventDefault();
  }

  function renderHeadlinePreview() {
    const hl = $("stageHeadline");
    hl.textContent = headline;
    hl.style.display = headline ? "" : "none";
    const hd = $("stageHandle");
    hd.textContent = handle;
    hd.style.display = handle ? "" : "none";
  }

  // ------------------------------------------------------------ crop editor --
  function renderCropEditor() {
    const wrap = $("cropWrap");
    if (!mainFile || !mainMeta) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    const box = boxes[selectedBox];
    // The crop editor shows the video this box actually draws from.
    const srcUrl = box.source === "second" ? secondUrl : mainUrl;
    const cropVideo = $("cropVideo");
    if (srcUrl && cropVideo.dataset.src !== srcUrl) {
      cropVideo.dataset.src = srcUrl;
      cropVideo.src = srcUrl;
    }
    $("cropTitle").textContent =
      `Source region for ${labelFor(selectedBox)} — drag the frame over the video`;
    const frame = $("cropFrame");
    frame.style.aspectRatio = `${mainMeta.width} / ${mainMeta.height}`;
    const rect = $("cropRect");
    rect.style.left = `${box.crop.x * 100}%`;
    rect.style.top = `${box.crop.y * 100}%`;
    rect.style.width = `${box.crop.w * 100}%`;
    rect.style.height = `${box.crop.h * 100}%`;
  }

  function startCropDrag(startEvent, mode) {
    const frame = $("cropFrame");
    const rect = frame.getBoundingClientRect();
    const startX = startEvent.clientX, startY = startEvent.clientY;
    const orig = { ...boxes[selectedBox].crop };
    const move = (e) => {
      const dx = (e.clientX - startX) / rect.width;
      const dy = (e.clientY - startY) / rect.height;
      const c = { ...orig };
      if (mode === "move") { c.x = orig.x + dx; c.y = orig.y + dy; }
      else { c.w = orig.w + dx; c.h = orig.h + dy; }
      boxes[selectedBox] = { ...boxes[selectedBox], crop: clampCrop(c) };
      renderCropEditor();
      layoutBoxEls();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    startEvent.preventDefault();
  }

  // --------------------------------------------------------------- timeline --
  function buildTimeline() {
    if (!mainMeta || !mainMeta.duration) return;
    const video = $("mainVideo");
    // Waveform from the audio track (best effort — silent/missing audio just skips it).
    drawWaveform();
    captureThumbnails();
    positionMarkers();
    video.currentTime = playhead;
  }

  async function drawWaveform() {
    const cv = $("waveCanvas");
    const ctx = cv.getContext("2d");
    const W = cv.width = cv.offsetWidth || 800;
    const H = cv.height = 56;
    ctx.fillStyle = "#150d28";
    ctx.fillRect(0, 0, W, H);
    try {
      const buf = await mainFile.arrayBuffer();
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await actx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const hop = Math.floor(ch.length / W);
      ctx.fillStyle = "#ff2e88";
      for (let x = 0; x < W; x++) {
        let peak = 0;
        const start = x * hop;
        for (let j = start; j < start + hop && j < ch.length; j += 4) {
          const v = Math.abs(ch[j]);
          if (v > peak) peak = v;
        }
        const h = Math.max(2, peak * H);
        ctx.fillRect(x, (H - h) / 2, 1, h);
      }
      await actx.close();
      waveformData = true;
    } catch (e) {
      waveformData = false;
      ctx.fillStyle = "#b8a8dd";
      ctx.font = "13px system-ui";
      ctx.fillText("No audio waveform available — scrub with the video instead.", 12, H / 2 + 4);
    }
  }

  async function captureThumbnails() {
    const strip = $("thumbStrip");
    strip.innerHTML = "";
    if (!mainMeta || !mainMeta.duration) return;
    const tmp = document.createElement("video");
    tmp.muted = true;
    tmp.preload = "auto";
    tmp.src = mainUrl;
    const count = 8;
    try {
      await new Promise((res, rej) => { tmp.onloadedmetadata = res; tmp.onerror = rej; });
      for (let i = 0; i < count; i++) {
        const t = (mainMeta.duration * (i + 0.5)) / count;
        await new Promise((res) => {
          const onSeek = () => { tmp.removeEventListener("seeked", onSeek); res(); };
          tmp.addEventListener("seeked", onSeek);
          tmp.currentTime = Math.min(t, mainMeta.duration - 0.1);
          setTimeout(res, 800); // don't stall the page if a seek hangs
        });
        const cv = document.createElement("canvas");
        cv.width = 120; cv.height = Math.round(120 * (tmp.videoHeight / tmp.videoWidth));
        cv.getContext("2d").drawImage(tmp, 0, 0, cv.width, cv.height);
        cv.title = formatTime(t);
        cv.addEventListener("click", () => seekTo(t));
        strip.appendChild(cv);
      }
    } catch (e) { /* thumbnails are a bonus — the waveform still works */ }
    tmp.removeAttribute("src");
  }

  function positionMarkers() {
    const tl = $("timeline");
    const dur = mainMeta ? mainMeta.duration : 1;
    const pct = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
    $("inMarker").style.left = pct(inPoint);
    $("outMarker").style.left = pct(outPoint);
    $("rangeSel").style.left = pct(inPoint);
    $("rangeSel").style.width = `${Math.max(0, ((outPoint - inPoint) / dur) * 100)}%`;
    $("playMarker").style.left = pct(playhead);
    // 60-second guide: a line at In + 60s, if it falls inside the video.
    const g = $("guide60");
    if (inPoint + 60 < dur) {
      g.style.display = "";
      g.style.left = pct(inPoint + 60);
      g.title = "60 seconds from In — the Shorts length";
    } else g.style.display = "none";
    updateLengthReadout();
  }

  function updateLengthReadout() {
    const len = clipLen();
    $("lenReadout").textContent =
      `Clip: ${formatTime(inPoint)} → ${formatTime(outPoint)} · ${len.toFixed(1)}s` +
      (len > 60 ? " — over 60s, this is a long-form clip, not a Short" :
        len === 60 ? " — exactly 60s, Shorts length" : "");
  }

  function seekTo(t) {
    if (!mainMeta) return;
    playhead = Math.max(0, Math.min(mainMeta.duration, t));
    $("mainVideo").currentTime = playhead;
    positionMarkers();
  }

  // ------------------------------------------------------------ face tracking --
  // Per-box face tracking, computed in the browser DURING EXPORT (not live in
  // the preview — live tracking would fight the preview video for CPU).
  // MediaPipe Tasks Vision (BlazeFace) scans the clip at ~2 frames/second,
  // picks the face nearest the box's crop region, smooths the path, and the
  // export then moves the crop with ffmpeg sendcmd commands. If no face is
  // found, the box simply stays still — never a failed export.
  let faceDetector = null;
  async function loadFaceDetector() {
    if (faceDetector) return faceDetector;
    const vision = await import(MEDIAPIPE_BUNDLE);
    const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    faceDetector = await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    });
    return faceDetector;
  }

  // Analyse one tracked box across the clip. Returns
  // { found, total, commands } — commands is the sendcmd script text, or null
  // when no face was found at all. Also moves the box's static crop to the
  // first tracked position (the fallback before the first command applies).
  async function analyseTracking(boxIdx) {
    const box = boxes[boxIdx];
    const srcUrl = box.source === "second" ? secondUrl : mainUrl;
    const meta = box.source === "second" ? secondMeta : mainMeta;
    const len = clipLen();
    const step = Math.max(0.5, len / 240); // at most ~240 samples
    const times = [];
    for (let t = 0; t <= len + 1e-6; t += step) times.push(Math.min(t, len));
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = srcUrl;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; });
    const det = await loadFaceDetector();
    const cw = Math.min(480, meta.width);
    const ch = Math.round((cw * meta.height) / meta.width);
    const cv = document.createElement("canvas");
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext("2d");
    const anchor = { x: box.crop.x + box.crop.w / 2, y: box.crop.y + box.crop.h / 2 };
    const samples = [];
    for (let i = 0; i < times.length; i++) {
      const absT = inPoint + times[i];
      await new Promise((res) => {
        const onSeek = () => { v.removeEventListener("seeked", onSeek); res(); };
        v.addEventListener("seeked", onSeek);
        v.currentTime = Math.min(absT, Math.max(0, (meta.duration || absT) - 0.05));
        setTimeout(res, 600);
      });
      ctx.drawImage(v, 0, 0, cw, ch);
      let face = null;
      try {
        const result = det.detect(cv);
        const dets = (result && result.detections) || [];
        let best = null, bestD = Infinity;
        for (const d of dets) {
          const bb = d.boundingBox;
          if (!bb) continue;
          const cx = (bb.originX + bb.width / 2) / cw;
          const cy = (bb.originY + bb.height / 2) / ch;
          const dist = Math.hypot(cx - anchor.x, cy - anchor.y);
          if (dist < bestD) { bestD = dist; best = { x: cx, y: cy }; }
        }
        // Only accept a face near the box's region — a far-away face is
        // probably a different person; hold position instead.
        if (best && bestD < 0.6) face = best;
      } catch (e) { /* detection failed on this frame — hold position */ }
      samples.push({ t: times[i], face });
      if (i % 20 === 0 || i === times.length - 1) {
        setStatus(`Tracking face in ${labelFor(boxIdx)}… ${Math.round(((i + 1) / times.length) * 100)}%`);
      }
    }
    v.removeAttribute("src");
    const foundCount = samples.filter((s) => s.face).length;
    if (foundCount === 0) return { found: 0, total: samples.length, commands: null };
    // Trajectory: hold the last known face through gaps, then smooth.
    const centres = [];
    let last = { ...anchor };
    for (const s of samples) {
      if (s.face) last = s.face;
      centres.push({ t: s.t, x: last.x, y: last.y });
    }
    const sm = centres.map((_, i) => {
      let sx = 0, sy = 0, n = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(centres.length - 1, i + 2); k++) {
        sx += centres[k].x; sy += centres[k].y; n++;
      }
      return { t: centres[i].t, x: sx / n, y: sy / n };
    });
    for (let i = 1; i < sm.length; i++) {
      const maxStep = 0.08; // never jump more than 8% of the frame per sample
      sm[i].x = sm[i - 1].x + Math.max(-maxStep, Math.min(maxStep, sm[i].x - sm[i - 1].x));
      sm[i].y = sm[i - 1].y + Math.max(-maxStep, Math.min(maxStep, sm[i].y - sm[i - 1].y));
    }
    const srcW = meta.width, srcH = meta.height;
    const cropW = box.crop.w, cropH = box.crop.h;
    const cropPxW = Math.max(2, 2 * Math.round((cropW * srcW) / 2));
    const cropPxH = Math.max(2, 2 * Math.round((cropH * srcH) / 2));
    const lines = [];
    for (const p of sm) {
      const x = Math.max(0, Math.min(srcW - cropPxW, Math.round((p.x - cropW / 2) * srcW)));
      const y = Math.max(0, Math.min(srcH - cropPxH, Math.round((p.y - cropH / 2) * srcH)));
      lines.push(`${p.t.toFixed(2)} crop@trk${boxIdx} x ${2 * Math.round(x / 2)};`);
      lines.push(`${p.t.toFixed(2)} crop@trk${boxIdx} y ${2 * Math.round(y / 2)};`);
    }
    const first = sm[0];
    box.crop = clampCrop({
      x: Math.max(0, Math.min(1 - cropW, first.x - cropW / 2)),
      y: Math.max(0, Math.min(1 - cropH, first.y - cropH / 2)),
      w: cropW, h: cropH,
    });
    return { found: foundCount, total: samples.length, commands: lines.join("\n") + "\n" };
  }

  // ------------------------------------------------------------------ export --
  async function exportClip() {
    if (running) return;
    if (!mainFile) { setStatus("Upload a video first — Step 1."); return; }
    if (outPoint <= inPoint) { setStatus("Set an Out point after the In point first."); return; }
    running = true;
    const btn = $("exportBtn");
    btn.disabled = true;
    btn.textContent = "Exporting…";
    const stopRunning = () => {
      running = false;
      btn.disabled = false;
      btn.textContent = "Export Clip";
    };
    try {
      const ff = await loadCutter();
      setProgress(0.15);
      const len = clipLen();
      const c = canvas();
      const ext = (mainFile.name.split(".").pop() || "mp4").toLowerCase();
      const inputName = `input.${ext}`;
      if (!inputsWritten) {
        await ff.writeFile(inputName, await ffmpegUtil.fetchFile(mainFile));
        if (secondFile) {
          const ext2 = (secondFile.name.split(".").pop() || "mp4").toLowerCase();
          await ff.writeFile(`input2.${ext2}`, await ffmpegUtil.fetchFile(secondFile));
        }
        inputsWritten = true;
      }
      const ext2 = secondFile ? (secondFile.name.split(".").pop() || "mp4").toLowerCase() : null;

      // Face tracking (per box, export-time): analyse tracked boxes first.
      const trackFiles = {};
      for (let i = 0; i < boxes.length; i++) {
        if (!boxes[i].track) continue;
        setStatus(`Tracking face in ${labelFor(i)} — analysing the clip in your browser, no upload…`);
        try {
          const res = await analyseTracking(i);
          if (res.commands) {
            const fname = `track${i}.txt`;
            await ff.writeFile(fname, new TextEncoder().encode(res.commands));
            trackFiles[i] = fname;
            log(`Face tracking ${labelFor(i)}: face found in ${res.found}/${res.total} samples — crop will follow it.`);
          } else {
            log(`Face tracking ${labelFor(i)}: no face found in ${res.total} samples — box stays still.`);
            setStatus(`No face found for ${labelFor(i)} — that box will stay still. The rest of the clip still exports.`);
          }
        } catch (e) {
          log(`Face tracking ${labelFor(i)} failed (${e.message || e}) — box stays still.`);
        }
      }
      renderBoxes();
      renderBoxList();
      setProgress(0.5);

      // Captions: typed words win if the box was edited, else uploaded file,
      // else embedded track in the video (scanned now), else none.
      let words = [];
      let capSource = "none";
      if (captionDirty && captionText.trim()) {
        words = distributeWords(captionText, 0, len);
        capSource = "typed";
      } else {
        let cues = uploadedCues;
        if (!cues.length) {
          setStatus("Checking the video for captions inside it…");
          embeddedCues = await extractEmbeddedCues(ff, inputName);
          cues = embeddedCues;
        }
        if (cues.length) {
          words = wordsForWindow(cues, inPoint, outPoint);
          capSource = uploadedCues.length ? "file" : "embedded";
        }
      }
      setStatus(`Exporting ${len.toFixed(1)}s · ${c.width}×${c.height} · ${LAYOUT_PRESETS[preset].label}` +
        (words.length ? ` · ${words.length} captioned words` : " · no captions") + "…");
      setProgress(0.6);
      log(`Export: ${formatTime(inPoint)}–${formatTime(outPoint)}, ${c.width}x${c.height}, preset ${preset}, sync ${syncOffset}s, captions: ${capSource}.`);

      const { filter } = buildLayoutFilter(boxes, c, len, trackFiles);
      let filterOut = filter;
      if (words.length || headline.trim() || handle.trim()) {
        const ass = buildAss(words, style, {
          width: c.width, height: c.height,
          headline: headline.trim(), handle: handle.trim(), duration: len,
        });
        await ff.writeFile("subs.ass", new TextEncoder().encode(ass));
        // The graph ends with [v]; splice the ass filter in before it.
        filterOut = filter.replace(/\[v\]$/, ",ass=subs.ass[v]");
      }

      const outName = "studio-clip.mp4";
      const args = ["-ss", String(inPoint), "-i", inputName];
      if (secondFile) args.push("-itsoffset", String(syncOffset), "-i", `input2.${ext2}`);
      args.push("-t", String(len),
        "-filter_complex", `${filterOut}[v]`,
        "-map", "[v]", "-map", "0:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", "-y", outName);
      try {
        await ff.exec(args);
      } catch (e) {
        // No audio track in the source: retry without audio mapping.
        const noAudio = ["-ss", String(inPoint), "-i", inputName];
        if (secondFile) noAudio.push("-itsoffset", String(syncOffset), "-i", `input2.${ext2}`);
        noAudio.push("-t", String(len),
          "-filter_complex", `${filterOut}[v]`, "-map", "[v]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-an", "-movflags", "+faststart", "-y", outName);
        await ff.exec(noAudio);
      }
      const data = await ff.readFile(outName);
      const blob = new Blob([data], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const baseName = mainFile.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 40) || "clip";
      const filename = `${baseName}-studio-${c.width}x${c.height}.mp4`;
      $("resultVideo").src = url;
      const dl = $("downloadLink");
      dl.href = url;
      dl.download = filename;
      dl.textContent = `Download ${filename} (${formatSize(blob.size)})`;
      $("resultsCard").style.display = "";
      $("resultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
      setProgress(1);
      setStatus(`<b>Done — your clip is ready.</b> Watch it below, then download. ${formatSize(blob.size)} · ${c.width}×${c.height} · H.264 + AAC · no watermark.`);
      try {
        await ff.deleteFile(outName);
        await ff.deleteFile("subs.ass");
        for (const f of Object.values(trackFiles)) await ff.deleteFile(f);
      } catch (e) { /* ignore */ }
    } catch (err) {
      console.error(err);
      setStatus(`Something went wrong while exporting: ${escapeHtml(err.message || String(err))}. Try a shorter clip, or reload the page and try again.`);
      log(`Error: ${err.message || err}`);
    } finally {
      stopRunning();
    }
  }

  // ------------------------------------------------------------ wiring: mode --
  document.querySelectorAll("#modeToggle .pill").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("addBoxBtn").addEventListener("click", addBox);
  $("autoArrangeBtn").addEventListener("click", autoArrangeBoxes);

  // ------------------------------------------------------------ wiring: step 1 --
  const dropZone = $("dropZone"), fileInput = $("fileInput");
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => pickMain(fileInput.files && fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); }));
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickMain(f);
  });

  $("secondInput").addEventListener("change", (e) => pickSecond(e.target.files && e.target.files[0]));
  $("clearSecondBtn").addEventListener("click", clearSecond);
  $("syncSlider").addEventListener("input", (e) => {
    syncOffset = parseFloat(e.target.value) || 0;
    $("syncLabel").textContent = syncOffset === 0 ? "0s — in sync"
      : syncOffset > 0 ? `+${syncOffset.toFixed(1)}s — 2nd video starts later`
      : `${syncOffset.toFixed(1)}s — 2nd video starts earlier`;
  });

  $("srtInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      uploadedCues = parseSrt(await f.text());
      $("capStatus").textContent = `Captions file loaded — ${uploadedCues.length} cues from ${f.name}.`;
      setStatus(`Captions file loaded — ${uploadedCues.length} cues. They will be used for the burned-in subtitles.`);
    } catch (err) {
      uploadedCues = [];
      $("capStatus").textContent = "I couldn't read that captions file. It needs to be .srt or .vtt format.";
    }
  });

  // ------------------------------------------------------------ wiring: step 2 --
  Object.entries(CANVAS_SIZES).forEach(([key, size]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill" + (key === canvasKey ? " selected" : "");
    b.textContent = size.label;
    b.addEventListener("click", () => {
      canvasKey = key;
      document.querySelectorAll("#canvasPills .pill").forEach((el) => el.classList.remove("selected"));
      b.classList.add("selected");
      applyLayout();
    });
    $("canvasPills").appendChild(b);
  });

  Object.entries(LAYOUT_PRESETS).forEach(([key, p]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.preset = key;
    b.className = "pill" + (key === preset ? " selected" : "");
    b.innerHTML = `<b>${escapeHtml(p.label)}</b><br><span style="color:var(--muted);font-weight:400">${escapeHtml(p.description)}</span>`;
    b.addEventListener("click", () => {
      preset = key;
      document.querySelectorAll("#presetPills .pill").forEach((el) => el.classList.remove("selected"));
      b.classList.add("selected");
      $("cornerRow").style.display = (key === "game-facecam") ? "" : "none";
      applyLayout();
    });
    $("presetPills").appendChild(b);
  });

  Object.entries(FACE_CAM_CORNERS).forEach(([key, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill small" + (key === corner ? " selected" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      corner = key;
      document.querySelectorAll("#cornerPills .pill").forEach((el) => el.classList.remove("selected"));
      b.classList.add("selected");
      boxes = snapCorner(boxes, canvas().width, canvas().height, corner);
      renderBoxes();
    });
    $("cornerPills").appendChild(b);
  });

  $("cropRect").addEventListener("pointerdown", (e) => startCropDrag(e, "move"));
  $("cropResize").addEventListener("pointerdown", (e) => { e.stopPropagation(); startCropDrag(e, "resize"); });
  $("cropFullBtn").addEventListener("click", () => {
    boxes[selectedBox] = { ...boxes[selectedBox], crop: { x: 0, y: 0, w: 1, h: 1 } };
    renderCropEditor();
    layoutBoxEls();
  });
  $("cropSwapBtn").addEventListener("click", () => {
    selectBox(selectedBox === 0 ? 1 : 0);
  });

  // ------------------------------------------------------------ wiring: step 3 --
  const video = $("mainVideo");
  video.addEventListener("timeupdate", () => {
    playhead = video.currentTime;
    positionMarkers();
    syncPreviewVideos();
  });
  video.addEventListener("play", syncPreviewVideos);
  video.addEventListener("pause", syncPreviewVideos);
  video.addEventListener("seeked", syncPreviewVideos);
  $("playBtn").addEventListener("click", () => {
    if (video.paused) video.play(); else video.pause();
    $("playBtn").textContent = video.paused ? "▶ Play" : "⏸ Pause";
  });
  $("setInBtn").addEventListener("click", () => {
    inPoint = playhead;
    if (outPoint <= inPoint) outPoint = Math.min(mainMeta.duration, inPoint + 10);
    positionMarkers();
  });
  $("setOutBtn").addEventListener("click", () => {
    outPoint = playhead;
    if (outPoint <= inPoint) inPoint = Math.max(0, outPoint - 10);
    positionMarkers();
  });
  $("timeline").addEventListener("click", (e) => {
    if (e.target.closest(".marker")) return;
    const rect = $("timeline").getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * (mainMeta ? mainMeta.duration : 0));
  });
  function markerDrag(markerEl, which) {
    markerEl.addEventListener("pointerdown", (startEvent) => {
      startEvent.stopPropagation();
      const rect = $("timeline").getBoundingClientRect();
      const move = (e) => {
        const t = ((e.clientX - rect.left) / rect.width) * (mainMeta ? mainMeta.duration : 0);
        if (which === "in") { inPoint = Math.max(0, Math.min(t, outPoint - 0.5)); }
        else { outPoint = Math.min(mainMeta.duration, Math.max(t, inPoint + 0.5)); }
        positionMarkers();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      startEvent.preventDefault();
    });
  }
  markerDrag($("inMarker"), "in");
  markerDrag($("outMarker"), "out");

  // ------------------------------------------------------------ wiring: step 4 --
  $("headlineInput").addEventListener("input", (e) => {
    headline = e.target.value;
    renderHeadlinePreview();
  });
  $("handleInput").addEventListener("input", (e) => {
    handle = e.target.value;
    renderHeadlinePreview();
  });
  STYLE_ORDER.forEach((name) => {
    const st = SUBTITLE_STYLES[name];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "style-opt" + (name === style ? " selected" : "");
    b.innerHTML =
      `<span class="swatch" style="color:${st.color};text-shadow:2px 0 0 ${st.outlineColor},-2px 0 0 ${st.outlineColor},0 2px 0 ${st.outlineColor},0 -2px 0 ${st.outlineColor};">best <span class="hl" style="color:${st.highlight}">moment</span></span><br>` +
      `<b>${escapeHtml(st.label)}</b><br><span style="color:var(--muted)">${escapeHtml(st.description)}</span>`;
    b.addEventListener("click", () => {
      style = name;
      document.querySelectorAll("#stylePicker .style-opt").forEach((el) => el.classList.remove("selected"));
      b.classList.add("selected");
    });
    $("stylePicker").appendChild(b);
  });
  $("capText").addEventListener("input", (e) => {
    captionText = e.target.value;
    captionDirty = true;
    $("capStatus").textContent = captionText.trim()
      ? "Typed captions will be spread evenly over the clip — they override any file or embedded captions."
      : "Typed captions cleared — file or embedded captions will be used if there are any.";
  });

  $("exportBtn").addEventListener("click", exportClip);
  $("newClipBtn").addEventListener("click", () => {
    $("resultsCard").style.display = "none";
    $("exportBtn").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Initial render
  applyLayout();
  positionMarkers();
}
