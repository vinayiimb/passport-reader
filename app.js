import { parsePassport, toJSON, toCSV, toTSV } from "./parser.js";

const $ = id => document.getElementById(id);
const canvas = $("canvas"), statusEl = $("status"), bar = $("bar"), raw = $("raw");
const MAX_SIDE = 2200;   // enough for OCR, small enough to stay quick on phones

let rows = [], source = null, rotation = 0;
let phase = { msg: "", from: 0, span: 0 };   // which part of the progress bar the current OCR pass fills

// MARK: OCR engine — created at page load so the ~3 MB language data is ready by the time a photo arrives

const setStatus = (msg, progress) => {
  statusEl.textContent = msg;
  bar.classList.toggle("show", progress != null);
  bar.firstElementChild.style.transform = `scaleX(${progress ?? 0})`;
};

const workerReady = Tesseract.createWorker("eng", 1, {
  logger: m => {
    if (m.status === "recognizing text") setStatus(phase.msg, phase.from + m.progress * phase.span);
    else if (!source) setStatus("Loading the text reader…", m.progress);
  },
}).then(async w => {
  await w.setParameters({ tessedit_pageseg_mode: "3" });   // auto layout: photo, labels and values sit in columns
  if (!source) setStatus("Ready — add a passport image.");
  return w;
})
  .catch(e => { setStatus("Couldn't load the text reader — check your connection and reload."); throw e; });

// Second engine trained on the OCR-B font of the MRZ (DoubangoTelecom/tesseractMRZ, BSD-3, hosted in lang/).
// The general English model reads the '<' filler as C/K/L, which breaks the coded lines.
const mrzWorkerReady = Tesseract.createWorker("mrz", 1, {
  langPath: new URL("lang", location.href).href,
  logger: m => { if (m.status === "recognizing text") setStatus(phase.msg, phase.from + m.progress * phase.span); },
}).then(async w => {
  await w.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<" });
  return w;
});

// One read at a time; a newer image supersedes any read still in flight.
let job = Promise.resolve(), generation = 0;

// MARK: image loading

function loadScript(src, integrity) {
  return new Promise((ok, fail) => {
    const s = Object.assign(document.createElement("script"), { src, integrity, crossOrigin: "anonymous", onload: ok, onerror: fail });
    document.head.append(s);
  });
}

async function renderPDF(file) {
  if (!window.pdfjsLib) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
  const c = Object.assign(document.createElement("canvas"), { width: viewport.width, height: viewport.height });
  await page.render({ canvasContext: c.getContext("2d"), viewport }).promise;
  return c;
}

async function toSource(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return renderPDF(file);
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });   // applies the phone's EXIF rotation
  } catch {
    throw new Error(/hei[cf]/i.test(file.type + file.name)
      ? "This browser can't open HEIC photos — open the page in Safari, or send the photo as JPG."
      : "Couldn't open that file as an image.");
  }
}

/** Draws the source scaled down to MAX_SIDE and rotated by `rotation` degrees into the preview canvas. */
function draw() {
  const s = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const w = Math.round(source.width * s), h = Math.round(source.height * s);
  const turned = rotation % 180 !== 0;
  canvas.width = turned ? h : w;
  canvas.height = turned ? w : h;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** Crops the MRZ band (lines with many '<', else the bottom third), upscales and greys it for a second, MRZ-only pass. */
function mrzCrop(lines) {
  const hits = lines.filter(l => (l.text.match(/</g) || []).length >= 3);
  let y0 = canvas.height * 0.62, y1 = canvas.height;
  if (hits.length) {
    const pad = (hits[0].bbox.y1 - hits[0].bbox.y0) * 1.2;
    y0 = Math.max(0, Math.min(...hits.map(l => l.bbox.y0)) - pad);
    y1 = Math.min(canvas.height, Math.max(...hits.map(l => l.bbox.y1)) + pad);
  }
  const s = Math.max(1, 1800 / canvas.width);
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(canvas.width * s), height: Math.round((y1 - y0) * s) });
  const ctx = c.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.4)";
  ctx.drawImage(canvas, 0, y0, canvas.width, y1 - y0, 0, 0, c.width, c.height);
  return c;
}

const linesOf = data => data.lines ?? (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines));

async function read() {
  const gen = ++generation;
  draw();
  $("preview").classList.add("show");
  job = job.then(async () => {
    if (gen !== generation) return;
    const t0 = performance.now();
    phase = { msg: "Reading the page…", from: 0, span: 0.7 };
    setStatus(phase.msg, 0);
    let worker;
    try { worker = await workerReady; } catch { return; }
    const full = (await worker.recognize(canvas)).data;
    if (gen !== generation) return;

    phase = { msg: "Checking the coded lines (MRZ)…", from: 0.7, span: 0.3 };
    setStatus(phase.msg, 0.7);
    // If the MRZ model failed to load, the page text above may still contain readable coded lines.
    const mrz = await mrzWorkerReady.then(w => w.recognize(mrzCrop(linesOf(full)))).then(r => r.data.text, () => "");
    if (gen !== generation) return;

    const text = `${full.text.trim()}\n${mrz.trim()}`;
    raw.value = text;
    show(parsePassport(text), ((performance.now() - t0) / 1000).toFixed(1));
  }).catch(e => { console.error(e); setStatus("Something went wrong while reading — try another photo."); });
}

async function loadFile(file) {
  if (!file) return;
  try {
    source = await toSource(file);
  } catch (e) {
    setStatus(e.message);
    return;
  }
  rotation = 0;
  read();
}

// MARK: results

function chipClass(note) {
  if (note.includes("✗")) return "bad";
  if (/inferred|printed text reads|auto-corrected/.test(note)) return "warn";
  if (note.includes("✓")) return "ok";
  return "";
}

function show(result, seconds) {
  rows = result.rows;
  const sum = $("summary");
  sum.hidden = false;
  sum.textContent = result.summary;
  sum.className = "summary " + (result.mrz && Object.values(result.mrz.ok).every(Boolean) ? "ok" : "warn");
  const list = $("fields");
  list.replaceChildren();
  if (!rows.length) list.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "No passport fields found. Try a sharper, straight-on photo of the data page, or rotate it." }));
  rows.forEach((r, i) => {
    const id = `f-${r.key}`;
    const row = Object.assign(document.createElement("div"), { className: "field" });
    const label = Object.assign(document.createElement("label"), { htmlFor: id, textContent: r.label });
    const input = Object.assign(document.createElement("input"), { id, value: r.value, autocomplete: "off", spellcheck: false });
    input.addEventListener("input", () => { rows[i].value = input.value; rows[i].iso = null; });   // an edited date no longer matches its ISO form
    const chip = Object.assign(document.createElement("span"), { className: "chip " + chipClass(r.note), textContent: r.note, title: r.note });
    row.append(label, input, chip);
    list.append(row);
  });
  $("actions").hidden = !rows.length;
  if (seconds) setStatus(`Done in ${seconds} s. Check each value, edit if needed, then copy.`);
}

// MARK: copy / download

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch { raw.value = text; $("rawBox").open = true; raw.select(); toast("Copy blocked — text selected below, press Ctrl/⌘ C"); }
}

function download(text, ext, type) {
  const name = (rows.find(r => r.key === "surname")?.value || "passport").replace(/[^A-Za-z0-9]+/g, "_");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: `${name}.${ext}` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("copyTSV").onclick = () => copy(toTSV(rows), "Table");
$("copyJSON").onclick = () => copy(toJSON(rows), "JSON");
$("dlCSV").onclick = () => download(toCSV(rows), "csv", "text/csv");
$("dlJSON").onclick = () => download(toJSON(rows), "json", "application/json");
$("reparse").onclick = () => show(parsePassport(raw.value));

// MARK: inputs

for (const id of ["camera", "file"]) $(id).addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });

$("rotate").onclick = () => { if (source) { rotation = (rotation + 90) % 360; read(); } };

$("clear").onclick = () => {
  generation++;
  source = null; rows = []; rotation = 0;
  canvas.width = canvas.height = 0;
  raw.value = "";
  $("preview").classList.remove("show");
  $("summary").hidden = true;
  $("actions").hidden = true;
  $("fields").replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "Cleared. Nothing was stored or uploaded." }));
  setStatus("Ready — add a passport image.");
};

const drop = $("drop");
window.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
window.addEventListener("dragleave", e => { if (!e.relatedTarget) drop.classList.remove("over"); });
window.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); loadFile(e.dataTransfer.files[0]); });

window.addEventListener("paste", e => {
  if (e.target.closest?.("input, textarea")) return;
  const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); loadFile(item.getAsFile()); }
});
