import { FREE_WIDTH, FREE_HEIGHT, WHITE, newProject, validateProject, stroke, hexToColor,
  colorToHex, pixelColors, pixelLine, fillRuns, pixelFill, copySelection, selectionEdits } from "./model.js";
import { makeZip } from "./zip.js";

const $ = id => document.getElementById(id);
const canvas = $("canvas"), ctx = canvas.getContext("2d");
const preview = $("preview-canvas"), previewCtx = preview.getContext("2d");
const state = {
  project: null, tool: "pen", color: hexToColor("#111111"), size: 4, pixelSize: 1,
  frame: 0, selection: null, clipboard: null, zoom: 1, panX: 0, panY: 0,
  pointers: new Map(), gesture: null, multi: null, blockedGesture: false,
  image: null, imageDirty: true, undo: [], redo: [], playing: true, previewFrame: 0
};
let db, saveQueue = Promise.resolve(), saveFailed = false, statusTimer, previewTimer;

function message(text, isError = false) {
  clearTimeout(statusTimer);
  $("status").textContent = text;
  $("status").style.background = isError ? "#8f303c" : "#283241";
  if (!isError) statusTimer = setTimeout(() => { $("status").textContent = ""; }, 3500);
}
function report(error) {
  console.error(error);
  message(error instanceof Error ? error.message : String(error), true);
}
function action(fn) {
  return event => {
    try { Promise.resolve(fn(event)).catch(report); } catch (error) { report(error); }
  };
}
window.addEventListener("unhandledrejection", event => { report(event.reason); event.preventDefault(); });

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("touchdraw-web", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Project storage is blocked by another open TouchDraw tab."));
  });
}
function transaction(mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", mode), request = operation(tx.objectStore("projects"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () => reject(tx.error || new Error("Project storage operation was cancelled."));
  });
}
function scheduleSave() {
  const project = state.project;
  if (!project) return;
  project.version = project.strokes.some(item => item.fillRuns?.length) ? 3 : 2;
  project.modifiedAt = Date.now();
  const snapshot = structuredClone(project);
  saveQueue = saveQueue.then(() => transaction("readwrite", store => store.put(snapshot)))
    .then(() => { saveFailed = false; })
    .catch(error => { saveFailed = true; report(new Error(`Could not save project: ${error.message}`)); });
}
function recordEdit(items) {
  if (!items.length) return;
  state.undo.push(state.project.strokes.slice());
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  state.project.strokes.push(...items);
  state.imageDirty = true;
  scheduleSave();
  updateUI();
  draw();
}
function undo() {
  if (state.undo.length) {
    state.redo.push(state.project.strokes.slice());
    state.project.strokes = state.undo.pop();
  } else if (state.project.strokes.length) {
    state.redo.push(state.project.strokes.slice());
    const group = state.project.strokes.at(-1).editGroup;
    state.project.strokes.pop();
    while (group && state.project.strokes.at(-1)?.editGroup === group) state.project.strokes.pop();
  } else return;
  state.selection = null; state.imageDirty = true; scheduleSave(); updateUI(); draw();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(state.project.strokes.slice());
  state.project.strokes = state.redo.pop();
  state.selection = null; state.imageDirty = true; scheduleSave(); updateUI(); draw();
}
function isPixel() { return state.project?.templateType === "pixel_art"; }
function dimensions(project = state.project) {
  return project.templateType === "pixel_art" ? [project.frameWidth, project.frameHeight] : [FREE_WIDTH, FREE_HEIGHT];
}
function makeCanvas(width, height) {
  const element = document.createElement("canvas");
  element.width = width; element.height = height;
  return element;
}
function rgbaToColor(data, index) {
  return ((data[index + 3] << 24) | (data[index] << 16) | (data[index + 1] << 8) | data[index + 2]) | 0;
}
function colorStyle(color) {
  return `rgba(${(color >>> 16) & 255},${(color >>> 8) & 255},${color & 255},${(color >>> 24) / 255})`;
}
function renderFreehand(project) {
  const image = makeCanvas(FREE_WIDTH, FREE_HEIGHT), c = image.getContext("2d");
  c.fillStyle = "#ffffff"; c.fillRect(0, 0, FREE_WIDTH, FREE_HEIGHT);
  c.lineCap = "round"; c.lineJoin = "round";
  for (const item of project.strokes) {
    c.fillStyle = c.strokeStyle = item.erased ? "#ffffff" : colorStyle(item.color);
    if (item.fillRuns?.length) {
      if (item.erased || (item.color >>> 24) === 255) {
        for (const [y, left, right] of item.fillRuns) c.fillRect(left, y, right - left, 1);
      } else {
        const pixels = c.getImageData(0, 0, FREE_WIDTH, FREE_HEIGHT);
        for (const [y, left, right] of item.fillRuns) {
          for (let x = left; x < right; x++) rgba(pixels.data, (y * FREE_WIDTH + x) * 4, item.color);
        }
        c.putImageData(pixels, 0, 0);
      }
    } else if (item.points.length) {
      c.lineWidth = item.width;
      const points = item.points;
      if (points.length === 1) {
        c.beginPath(); c.arc(points[0][0] * FREE_WIDTH, points[0][1] * FREE_HEIGHT, item.width / 2, 0, Math.PI * 2); c.fill();
      } else {
        c.beginPath(); c.moveTo(points[0][0] * FREE_WIDTH, points[0][1] * FREE_HEIGHT);
        for (const point of points.slice(1)) c.lineTo(point[0] * FREE_WIDTH, point[1] * FREE_HEIGHT);
        c.stroke();
      }
    }
  }
  return image;
}
function rgba(data, index, color, transparentWhite = false) {
  data[index] = (color >>> 16) & 255; data[index + 1] = (color >>> 8) & 255;
  data[index + 2] = color & 255; data[index + 3] = transparentWhite && color === WHITE ? 0 : (color >>> 24);
}
function renderFrame(project, frame, transparent = false, onions = []) {
  const size = project.frameWidth, width = size * project.frameCount, colors = pixelColors(project);
  const element = makeCanvas(size, size), c = element.getContext("2d"), image = c.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = (y * size + x) * 4, color = colors[y * width + frame * size + x];
    rgba(image.data, index, color, transparent);
    if (!transparent && color === WHITE) {
      for (const overlay of onions) {
        const ghost = colors[y * width + overlay * size + x];
        if (ghost !== WHITE) {
          image.data[index] = Math.round(image.data[index] * .8 + ((ghost >>> 16) & 255) * .2);
          image.data[index + 1] = Math.round(image.data[index + 1] * .8 + ((ghost >>> 8) & 255) * .2);
          image.data[index + 2] = Math.round(image.data[index + 2] * .8 + (ghost & 255) * .2);
        }
      }
    }
  }
  c.putImageData(image, 0, 0);
  return element;
}
function currentImage() {
  if (isPixel()) return renderFrame(state.project, state.frame, false, state.project.onionSkinFrames.filter(f => f !== state.frame));
  if (state.imageDirty) { state.image = renderFreehand(state.project); state.imageDirty = false; }
  return state.image;
}
function viewGeometry() {
  const rect = canvas.getBoundingClientRect(), [width, height] = dimensions();
  const scale = Math.min(rect.width / width, rect.height / height) * state.zoom;
  return { width, height, scale, x: (rect.width - width * scale) / 2 + state.panX,
    y: (rect.height - height * scale) / 2 + state.panY, rect };
}
function resize() {
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  draw();
}
function draw() {
  if (!state.project || $("editor").hidden) return;
  const g = viewGeometry(), dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, g.rect.width, g.rect.height);
  ctx.save(); ctx.translate(g.x, g.y); ctx.scale(g.scale, g.scale);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, g.width, g.height);
  ctx.imageSmoothingEnabled = !isPixel(); ctx.drawImage(currentImage(), 0, 0);
  const gesture = state.gesture;
  if (gesture?.kind === "freehand") {
    const points = gesture.points;
    ctx.strokeStyle = ctx.fillStyle = gesture.erased ? "#ffffff" : colorToHex(gesture.color);
    ctx.lineWidth = gesture.width; ctx.lineCap = ctx.lineJoin = "round";
    if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0] * g.width, points[0][1] * g.height, gesture.width / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(points[0][0] * g.width, points[0][1] * g.height); for (const p of points.slice(1)) ctx.lineTo(p[0] * g.width, p[1] * g.height); ctx.stroke(); }
  }
  if (gesture?.kind === "pixels") {
    ctx.fillStyle = gesture.erased ? "#ffffff" : colorToHex(gesture.color);
    const width = state.project.frameWidth * state.project.frameCount;
    for (const cell of gesture.cells) ctx.fillRect(cell % width - state.frame * g.width, Math.floor(cell / width), 1, 1);
  }
  if (isPixel() && g.scale >= 6) {
    ctx.beginPath(); ctx.strokeStyle = "#0003"; ctx.lineWidth = 1 / g.scale;
    for (let x = 0; x <= g.width; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, g.height); }
    for (let y = 0; y <= g.height; y++) { ctx.moveTo(0, y); ctx.lineTo(g.width, y); }
    ctx.stroke();
  }
  if (isPixel() && state.tool === "select" && state.selection) {
    const s = state.selection;
    ctx.strokeStyle = "#00a8ea"; ctx.lineWidth = 2 / g.scale; ctx.setLineDash([5 / g.scale, 3 / g.scale]);
    ctx.strokeRect(s.x, s.y, s.width, s.height);
  }
  ctx.restore();
}

function documentPoint(event, clamp = false) {
  const g = viewGeometry(), x = (event.clientX - g.rect.left - g.x) / g.scale;
  const y = (event.clientY - g.rect.top - g.y) / g.scale;
  if (!clamp && (x < 0 || y < 0 || x >= g.width || y >= g.height)) return null;
  return [Math.max(0, Math.min(g.width - 0.0001, x)), Math.max(0, Math.min(g.height - 0.0001, y))];
}
function pixelPoint(point) { return [Math.floor(point[0]), Math.floor(point[1])]; }
function selectionFromPoints(a, b) {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]) + 1, height: Math.abs(a[1] - b[1]) + 1 };
}
function selectionMove(original, from, to) {
  const size = state.project.frameWidth;
  return { ...original, x: Math.max(0, Math.min(size - original.width, original.x + to[0] - from[0])),
    y: Math.max(0, Math.min(size - original.height, original.y + to[1] - from[1])) };
}
function beginGesture(point) {
  if (!point) return;
  const p = pixelPoint(point);
  if (state.tool === "select" && isPixel()) {
    const s = state.selection;
    const inside = s && p[0] >= s.x && p[0] < s.x + s.width && p[1] >= s.y && p[1] < s.y + s.height;
    state.gesture = { kind: "selection", start: p, original: inside ? { ...s } : null,
      copy: inside ? copySelection(state.project, state.frame, s) : null };
    if (!inside) state.selection = selectionFromPoints(p, p);
  } else if (state.tool === "bucket" || state.tool === "eyedropper") {
    state.gesture = { kind: "action", point: p, tool: state.tool };
  } else if (isPixel()) {
    const cells = new Set();
    pixelLine(state.project, state.frame, p, p, state.pixelSize, cells);
    state.gesture = { kind: "pixels", cells, last: p, erased: state.tool === "eraser", color: state.color };
  } else {
    state.gesture = { kind: "freehand", points: [[point[0] / FREE_WIDTH, point[1] / FREE_HEIGHT]],
      erased: state.tool === "eraser", color: state.color, width: state.size };
  }
  draw();
}
function moveGesture(point) {
  const gesture = state.gesture;
  if (!gesture || !point) return;
  const p = pixelPoint(point);
  if (gesture.kind === "selection") {
    state.selection = gesture.original ? selectionMove(gesture.original, gesture.start, p) : selectionFromPoints(gesture.start, p);
  } else if (gesture.kind === "pixels") {
    pixelLine(state.project, state.frame, gesture.last, p, state.pixelSize, gesture.cells);
    gesture.last = p;
  } else if (gesture.kind === "freehand") {
    const next = [point[0] / FREE_WIDTH, point[1] / FREE_HEIGHT], last = gesture.points.at(-1);
    if (next[0] !== last[0] || next[1] !== last[1]) gesture.points.push(next);
  }
  draw();
}
function endGesture() {
  const gesture = state.gesture;
  state.gesture = null;
  if (!gesture) return;
  if (gesture.kind === "freehand") {
    recordEdit([stroke(gesture.color, { points: gesture.points, width: gesture.width, erased: gesture.erased })]);
  } else if (gesture.kind === "pixels") {
    recordEdit([stroke(gesture.color, { pixelCells: [...gesture.cells], erased: gesture.erased })]);
  } else if (gesture.kind === "selection" && gesture.original &&
    (gesture.original.x !== state.selection.x || gesture.original.y !== state.selection.y)) {
    recordEdit(selectionEdits(state.project, state.frame, gesture.copy, state.selection, gesture.original));
  } else if (gesture.kind === "action") {
    applyTool(gesture.tool, gesture.point);
  }
  updateUI(); draw();
}
function applyTool(tool, [x, y]) {
  if (isPixel()) {
    const width = state.project.frameWidth * state.project.frameCount;
    if (tool === "eyedropper") {
      state.color = pixelColors(state.project)[y * width + state.frame * state.project.frameWidth + x];
      state.tool = "pen";
    } else {
      const cells = pixelFill(state.project, state.frame, x, y, state.color);
      if (cells.length) recordEdit([stroke(state.color, { pixelCells: cells })]);
    }
  } else {
    const image = currentImage(), c = image.getContext("2d", { willReadFrequently: true });
    if (tool === "eyedropper") {
      state.color = rgbaToColor(c.getImageData(x, y, 1, 1).data, 0) | 0xff000000;
      state.tool = "pen";
    } else {
      const data = c.getImageData(0, 0, FREE_WIDTH, FREE_HEIGHT).data;
      const colors = new Int32Array(FREE_WIDTH * FREE_HEIGHT);
      for (let i = 0; i < colors.length; i++) colors[i] = rgbaToColor(data, i * 4);
      const runs = fillRuns(colors, FREE_WIDTH, FREE_HEIGHT, x, y, state.color);
      if (runs.length) recordEdit([stroke(state.color, { fillRuns: runs })]);
    }
  }
}
function midpoint(pointers) {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}
canvas.addEventListener("pointerdown", action(event => {
  if (!state.project || event.button > 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.pointers.size === 1 && !state.blockedGesture) beginGesture(documentPoint(event));
  if (state.pointers.size === 2) {
    if (state.gesture?.kind === "selection") state.selection = state.gesture.original;
    state.gesture = null; state.blockedGesture = true; state.multi = midpoint(state.pointers); draw();
  }
}));
canvas.addEventListener("pointermove", action(event => {
  if (!state.pointers.has(event.pointerId)) return;
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.pointers.size >= 2 && state.multi) {
    const next = midpoint(state.pointers), before = state.multi, g = viewGeometry();
    if (before.distance > 0) {
      const px = before.x - g.rect.left, py = before.y - g.rect.top;
      const documentX = (px - g.x) / g.scale, documentY = (py - g.y) / g.scale;
      state.zoom = Math.max(1, Math.min(10, state.zoom * next.distance / before.distance));
      const updated = viewGeometry();
      state.panX += next.x - updated.rect.left - (updated.x + documentX * updated.scale);
      state.panY += next.y - updated.rect.top - (updated.y + documentY * updated.scale);
      state.multi = next; draw();
    }
  } else if (!state.blockedGesture) moveGesture(documentPoint(event, true));
}));
function finishPointer(event, cancelled) {
  if (!state.pointers.has(event.pointerId)) return;
  if (!state.blockedGesture && !cancelled) {
    moveGesture(documentPoint(event, true)); endGesture();
  } else if (cancelled && state.gesture) {
    if (state.gesture.kind === "selection") state.selection = state.gesture.original;
    state.gesture = null; draw();
  }
  state.pointers.delete(event.pointerId);
  if (state.pointers.size < 2) state.multi = null;
  if (!state.pointers.size) state.blockedGesture = false;
}
canvas.addEventListener("pointerup", action(event => finishPointer(event, false)));
canvas.addEventListener("pointercancel", action(event => finishPointer(event, true)));

function resetView() {
  state.zoom = 1; state.panX = 0; state.panY = 0; state.selection = null;
  state.gesture = null; state.pointers.clear(); state.multi = null; state.blockedGesture = false;
}
function updateUI() {
  const project = state.project;
  if (!project) return;
  const pixel = isPixel();
  $("project-name").textContent = project.name;
  document.querySelectorAll(".pixel-only").forEach(element => { element.hidden = !pixel; });
  $("export-freehand").hidden = pixel;
  document.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("active", button.dataset.tool === state.tool));
  $("color").value = colorToHex(state.color);
  $("size").hidden = pixel; $("size").value = state.size; $("size-value").textContent = pixel ? `${state.pixelSize}px` : `${state.size}px`;
  $("undo").disabled = !state.undo.length && !project.strokes.length;
  $("redo").disabled = !state.redo.length;
  $("copy").disabled = !state.selection; $("paste").disabled = !state.clipboard;
  $("frame").replaceChildren(...Array.from({ length: project.frameCount }, (_, index) => {
    const option = document.createElement("option"); option.value = index; option.textContent = `${index + 1} / ${project.frameCount}`; return option;
  }));
  $("frame").value = state.frame;
  for (const button of $("pixel-sizes").children) button.classList.toggle("active", Number(button.dataset.size) === state.pixelSize);
}
function openProject(project) {
  state.project = validateProject(project); state.frame = 0; state.tool = "pen";
  state.undo = []; state.redo = []; state.imageDirty = true; resetView();
  $("library").hidden = true; $("editor").hidden = false; updateUI(); resize();
}
async function showLibrary() {
  await saveQueue;
  if (saveFailed) throw new Error("The project could not be saved. Stay here and try Save again.");
  state.project = null; $("editor").hidden = true; $("library").hidden = false;
  const projects = (await transaction("readonly", store => store.getAll())).map(validateProject)
    .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
  $("projects").replaceChildren();
  $("empty").hidden = projects.length > 0;
  for (const project of projects) {
    const card = document.createElement("article"); card.className = "project";
    const thumb = makeCanvas(200, 150), t = thumb.getContext("2d");
    const image = project.templateType === "pixel_art" ? renderFrame(project, 0) : renderFreehand(project);
    t.fillStyle = "#fff"; t.fillRect(0, 0, 200, 150);
    const scale = Math.min(200 / image.width, 150 / image.height);
    t.imageSmoothingEnabled = project.templateType !== "pixel_art";
    t.drawImage(image, (200 - image.width * scale) / 2, (150 - image.height * scale) / 2, image.width * scale, image.height * scale);
    thumb.className = "thumbnail";
    const title = document.createElement("strong"); title.textContent = project.name;
    const subtitle = document.createElement("p"); subtitle.textContent = project.templateType === "pixel_art" ? `Pixel art · ${project.frameCount} frame(s)` : "Freehand";
    const actions = document.createElement("div"); actions.className = "project-actions";
    const open = document.createElement("button"); open.textContent = "Open"; open.addEventListener("click", action(() => openProject(project)));
    const remove = document.createElement("button"); remove.textContent = "Delete";
    remove.addEventListener("click", action(async () => {
      if (await confirmAction("Delete sketch?", `Delete “${project.name}” from this device?`)) {
        await transaction("readwrite", store => store.delete(project.id)); await showLibrary();
      }
    }));
    actions.append(open, remove); card.append(thumb, title, subtitle, actions); $("projects").append(card);
  }
}

function confirmAction(title, text) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title; $("confirm-text").textContent = text;
  return new Promise(resolve => {
    const finish = result => { dialog.close(); resolve(result); };
    $("confirm-yes").onclick = () => finish(true);
    $("confirm-no").onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}
function setTool(tool) {
  state.gesture = null; state.tool = tool;
  if (tool !== "select") state.selection = null;
  updateUI(); draw();
}
function frameOrder() {
  const parts = $("frame-order").value.split(",").map(value => value.trim());
  if (parts.some(value => !/^\d+$/.test(value))) throw new Error("Enter each frame number once, separated by commas.");
  const order = parts.map(value => Number(value) - 1);
  if (order.length !== state.project.frameCount || new Set(order).size !== order.length ||
    order.some(frame => frame < 0 || frame >= state.project.frameCount)) {
    throw new Error("Frame order must contain each frame exactly once.");
  }
  return order;
}
function exportSheet(order) {
  const size = state.project.frameWidth, image = makeCanvas(size * order.length, size);
  const c = image.getContext("2d"); c.imageSmoothingEnabled = false;
  order.forEach((frame, index) => c.drawImage(renderFrame(state.project, frame, true), index * size, 0));
  return image;
}
function pngFile(image, name) {
  return new Promise((resolve, reject) => image.toBlob(blob => {
    if (!blob) reject(new Error("Could not encode PNG."));
    else resolve(new File([blob], name, { type: "image/png" }));
  }, "image/png"));
}
function fileName() { return state.project.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "TouchDraw"; }
async function shareFiles(files, zipName) {
  if (navigator.canShare?.({ files }) && navigator.share) {
    try { await navigator.share({ files }); } catch (error) { if (error.name !== "AbortError") throw error; }
    return;
  }
  let file = files[0];
  if (files.length > 1) file = new File([await makeZip(files)], zipName, { type: "application/zip" });
  const url = URL.createObjectURL(file), link = document.createElement("a");
  link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  message(files.length > 1 ? "Frames downloaded as a ZIP file." : "File downloaded.");
}
async function prepareFiles(files, zipName) {
  if (files.length > 1 && !(navigator.canShare?.({ files }) && navigator.share)) {
    files = [new File([await makeZip(files)], zipName, { type: "application/zip" })];
  }
  state.preparedFiles = files;
  $("share-prepared").hidden = false;
  message("Ready to share or download.");
}
function showPreview() {
  const project = state.project, size = project.frameWidth, width = size * project.frameCount, colors = pixelColors(project);
  const frames = Array.from({ length: project.frameCount }, (_, frame) => frame).filter(frame => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (colors[y * width + frame * size + x] !== WHITE) return true;
    }
    return false;
  });
  state.previewFrame = 0; state.playing = true; $("play").textContent = "Pause"; $("fps").value = project.previewFps;
  const paint = () => {
    previewCtx.fillStyle = "#fff"; previewCtx.fillRect(0, 0, preview.width, preview.height);
    if (!frames.length) return;
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.drawImage(renderFrame(project, frames[state.previewFrame % frames.length], true), 0, 0, preview.width, preview.height);
    if (state.playing) state.previewFrame++;
  };
  const restart = () => { clearInterval(previewTimer); previewTimer = setInterval(paint, 1000 / project.previewFps); };
  $("play").onclick = () => { state.playing = !state.playing; $("play").textContent = state.playing ? "Pause" : "Play"; };
  $("fps").onchange = action(() => {
    const fps = Number($("fps").value);
    if (!Number.isInteger(fps) || fps < 2 || fps > 24) { $("fps").value = project.previewFps; throw new Error("FPS must be between 2 and 24."); }
    project.previewFps = fps; scheduleSave(); restart();
  });
  $("preview-dialog").showModal(); paint(); restart();
}

$("new").addEventListener("click", () => $("new-dialog").showModal());
$("new-form").elements.template.addEventListener("change", event => { $("new-pixel").hidden = event.target.value !== "pixel"; });
$("new-form").addEventListener("submit", action(event => {
  event.preventDefault();
  const fields = event.currentTarget.elements;
  const project = newProject(fields.name.value, fields.template.value === "pixel", Number(fields.size.value), Number(fields.frames.value));
  $("new-dialog").close(); openProject(project); scheduleSave();
}));
$("back").addEventListener("click", action(showLibrary));
$("save").addEventListener("click", action(async () => { scheduleSave(); await saveQueue; if (!saveFailed) message("Project saved on this device."); }));
$("undo").addEventListener("click", action(undo));
$("redo").addEventListener("click", action(redo));
$("fit").addEventListener("click", action(() => { state.zoom = 1; state.panX = 0; state.panY = 0; draw(); }));
$("clear").addEventListener("click", action(async () => {
  if (await confirmAction("Clear canvas?", "This clears all frames and undo history.")) {
    state.project.strokes = []; state.undo = []; state.redo = []; state.selection = null;
    state.imageDirty = true; scheduleSave(); updateUI(); draw();
  }
}));
$("flip").addEventListener("click", action(() => {
  const editor = $("editor"), toolbar = $("toolbar"), workspace = $("workspace");
  if (toolbar.nextElementSibling === workspace) editor.append(toolbar);
  else editor.insertBefore(toolbar, workspace);
  resize();
}));
$("record").addEventListener("click", () => {
  alert("On iPhone or iPad, open Control Center and tap Screen Recording. Stop it from Control Center when finished.");
});
document.querySelectorAll("[data-tool]").forEach(button => button.addEventListener("click", action(() => setTool(button.dataset.tool))));
$("color").addEventListener("input", action(event => { state.color = hexToColor(event.target.value); }));
$("size").addEventListener("input", action(event => { state.size = Number(event.target.value); updateUI(); }));
for (const size of [1, 2, 4, 8]) {
  const button = document.createElement("button"); button.textContent = `${size}px`; button.dataset.size = size;
  button.addEventListener("click", action(() => { state.pixelSize = size; updateUI(); }));
  $("pixel-sizes").append(button);
}
const presetKey = "touchdraw-color-presets";
function drawSwatches() {
  const colors = ["#111111", "#e53935", "#1e88e5", "#43a047", "#ffb300", "#8e24aa", "#00acc1", "#ffffff"];
  const stored = JSON.parse(localStorage.getItem(presetKey) || "[]");
  if (!Array.isArray(stored) || stored.some(color => typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new Error("Saved color presets are invalid.");
  }
  $("swatches").replaceChildren();
  for (const color of [...new Set([...colors, ...stored])]) {
    const button = document.createElement("button"); button.className = "swatch"; button.style.background = color;
    button.setAttribute("aria-label", `Color ${color}`);
    button.addEventListener("click", action(() => { state.color = hexToColor(color); updateUI(); }));
    $("swatches").append(button);
  }
}
$("save-color").addEventListener("click", action(() => {
  const colors = JSON.parse(localStorage.getItem(presetKey) || "[]"), color = colorToHex(state.color);
  if (!colors.includes(color)) localStorage.setItem(presetKey, JSON.stringify([...colors, color]));
  drawSwatches(); message("Color saved.");
}));
$("frame").addEventListener("change", action(event => {
  state.frame = Number(event.target.value); state.selection = null; state.gesture = null;
  if (state.project.onionSkinFrames.includes(state.frame)) {
    state.project.onionSkinFrames = state.project.onionSkinFrames.filter(frame => frame !== state.frame);
    scheduleSave();
  }
  updateUI(); draw();
}));
$("onion").addEventListener("click", action(() => {
  $("onion-list").replaceChildren();
  for (let frame = 0; frame < state.project.frameCount; frame++) {
    if (frame === state.frame) continue;
    const label = document.createElement("label"), box = document.createElement("input");
    box.type = "checkbox"; box.checked = state.project.onionSkinFrames.includes(frame);
    box.addEventListener("change", action(() => {
      const current = state.project.onionSkinFrames.filter(value => value !== frame);
      if (box.checked) current.push(frame);
      state.project.onionSkinFrames = current.sort((a, b) => a - b);
      state.project.onionSkinEnabled = current.length > 0; scheduleSave(); draw();
    }));
    label.append(box, document.createTextNode(` ${frame + 1}`)); $("onion-list").append(label);
  }
  $("onion-dialog").showModal();
}));
$("copy").addEventListener("click", action(() => {
  if (state.selection) { state.clipboard = copySelection(state.project, state.frame, state.selection); updateUI(); message("Selection copied."); }
}));
$("paste").addEventListener("click", action(() => {
  const copy = state.clipboard;
  if (!copy || !isPixel()) return;
  const size = state.project.frameWidth, width = Math.min(copy.width, size), height = Math.min(copy.height, size);
  state.selection = { x: Math.min(copy.x, size - width), y: Math.min(copy.y, size - height), width, height };
  state.tool = "select"; recordEdit(selectionEdits(state.project, state.frame, copy, state.selection)); updateUI(); draw();
}));
$("preview").addEventListener("click", action(showPreview));
$("preview-dialog").addEventListener("close", () => clearInterval(previewTimer));
$("export").addEventListener("click", action(() => {
  state.preparedFiles = null; $("share-prepared").hidden = true;
  $("frame-order").value = Array.from({ length: state.project.frameCount }, (_, i) => i + 1).join(", ");
  updateUI(); $("export-dialog").showModal();
}));
$("export-freehand").addEventListener("click", action(async () => prepareFiles([await pngFile(currentImage(), `${fileName()}.png`)])));
$("export-sheet").addEventListener("click", action(async () => prepareFiles([await pngFile(exportSheet(frameOrder()), `${fileName()}-spritesheet.png`)])));
$("export-frame").addEventListener("click", action(async () => prepareFiles([await pngFile(renderFrame(state.project, state.frame, true), `${fileName()}-${state.frame + 1}.png`)])));
$("export-frames").addEventListener("click", action(async () => {
  const files = [];
  for (const frame of frameOrder()) files.push(await pngFile(renderFrame(state.project, frame, true), `${fileName()}-${frame + 1}.png`));
  await prepareFiles(files, `${fileName()}-frames.zip`);
}));
$("export-json").addEventListener("click", action(async () => {
  await saveQueue;
  if (saveFailed) throw new Error("The project could not be saved.");
  await prepareFiles([new File([JSON.stringify(state.project)], `${fileName()}.json`, { type: "application/json" })]);
}));
$("share-prepared").addEventListener("click", action(() => shareFiles(state.preparedFiles)));
$("import").addEventListener("change", action(async event => {
  const file = event.target.files[0]; event.target.value = "";
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) throw new Error("Project file is larger than 50 MB.");
  const project = validateProject(JSON.parse(await file.text()));
  project.id = crypto.randomUUID(); project.modifiedAt = Date.now();
  await transaction("readwrite", store => store.put(project)); await showLibrary(); message("Project imported.");
}));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
canvas.addEventListener("wheel", action(event => {
  event.preventDefault();
  const g = viewGeometry(), x = event.clientX - g.rect.left, y = event.clientY - g.rect.top;
  const documentX = (x - g.x) / g.scale, documentY = (y - g.y) / g.scale;
  state.zoom = Math.max(1, Math.min(10, state.zoom * Math.exp(-event.deltaY * .002)));
  const next = viewGeometry();
  state.panX += x - (next.x + documentX * next.scale); state.panY += y - (next.y + documentY * next.scale);
  draw();
}), { passive: false });
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe($("workspace"));

async function initialize() {
  if (!isSecureContext) throw new Error("TouchDraw requires HTTPS (or localhost) for offline storage and installation.");
  db = await openDatabase(); drawSwatches(); await showLibrary();
  $("new").disabled = false; $("import").disabled = false;
  if (!("serviceWorker" in navigator)) throw new Error("Offline installation is not supported by this browser.");
  await navigator.serviceWorker.register("./service-worker.js");
  await navigator.serviceWorker.ready;
  message("Ready for offline use.");
}
initialize().catch(report);
