export const FREE_WIDTH = 2048;
export const FREE_HEIGHT = 1536;
export const WHITE = -1;

export function newProject(name, pixel = false, size = 32, frames = 1) {
  if (!name.trim() || (pixel && (![16, 32, 64].includes(size) || !Number.isInteger(frames) || frames < 1 || frames > 16))) {
    throw new Error("Choose a name, a supported frame size, and 1–16 frames.");
  }
  return {
    version: 2, id: crypto.randomUUID(), name: name.trim(), modifiedAt: Date.now(),
    templateType: pixel ? "pixel_art" : "default_freehand",
    frameWidth: pixel ? size : FREE_WIDTH, frameHeight: pixel ? size : FREE_HEIGHT,
    frameCount: pixel ? frames : 1, previewFps: 8, onionSkinEnabled: false,
    onionSkinFrames: [], strokes: []
  };
}

export function validateProject(project) {
  if (!project || ![1, 2, 3].includes(project.version) ||
      typeof project.id !== "string" || !project.id.trim() ||
      typeof project.name !== "string" || !Array.isArray(project.strokes)) {
    throw new Error("Invalid or unsupported TouchDraw project.");
  }
  if (project.version === 1) {
    project = { ...project, templateType: "default_freehand", frameWidth: FREE_WIDTH,
      frameHeight: FREE_HEIGHT, frameCount: 1, previewFps: 8,
      onionSkinEnabled: false, onionSkinFrames: [] };
  }
  project = { ...project, previewFps: project.previewFps ?? 8,
    onionSkinEnabled: project.onionSkinEnabled ?? false, onionSkinFrames: project.onionSkinFrames ?? [],
    strokes: project.strokes.map(item => item && ({
      ...item, points: item.points ?? [], pixelCells: item.pixelCells ?? [],
      width: item.width ?? 4, erased: item.erased ?? false
    })) };
  const pixel = project.templateType === "pixel_art";
  if ((!pixel && project.templateType !== "default_freehand") ||
      !Number.isInteger(project.frameCount) || project.frameCount < 1 || project.frameCount > 16 ||
      !Number.isInteger(project.previewFps) || project.previewFps < 2 || project.previewFps > 24 ||
      !Array.isArray(project.onionSkinFrames) ||
      project.onionSkinFrames.some(frame => !Number.isInteger(frame) || frame < 0 || frame >= project.frameCount) ||
      (pixel && (![16, 32, 64].includes(project.frameWidth) || project.frameHeight !== project.frameWidth))) {
    throw new Error("Invalid project dimensions or settings.");
  }
  const width = pixel ? project.frameWidth * project.frameCount : FREE_WIDTH;
  const height = pixel ? project.frameHeight : FREE_HEIGHT;
  for (const stroke of project.strokes) {
    if (!stroke || !Number.isInteger(stroke.color) || stroke.color < -2147483648 || stroke.color > 2147483647 ||
        !Number.isFinite(stroke.width) || stroke.width < 1 ||
        !Array.isArray(stroke.points) || !Array.isArray(stroke.pixelCells) ||
        stroke.points.some(p => !Array.isArray(p) || p.length !== 2 ||
          p.some(value => !Number.isFinite(value) || value < 0 || value > 1)) ||
        stroke.pixelCells.some(cell => !pixel || !Number.isInteger(cell) || cell < 0 || cell >= width * height) ||
        (stroke.fillRuns != null && (!Array.isArray(stroke.fillRuns) ||
          stroke.fillRuns.some(run => project.version < 3 || pixel || !Array.isArray(run) || run.length !== 3 ||
            run.some(value => !Number.isInteger(value)) || run[0] < 0 || run[0] >= height ||
            run[1] < 0 || run[1] >= run[2] || run[2] > width))) ||
        (stroke.fillRuns?.length && (stroke.points.length || stroke.pixelCells.length))) {
      throw new Error("The project contains an invalid stroke.");
    }
  }
  return project;
}

export function stroke(color, extra = {}) {
  return { color, width: 1, erased: false, points: [], pixelCells: [], ...extra };
}

export function hexToColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Invalid color.");
  return (0xff000000 | parseInt(hex.slice(1), 16)) | 0;
}

export function colorToHex(color) {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function pixelColors(project) {
  const width = project.frameWidth * project.frameCount;
  const colors = new Int32Array(width * project.frameHeight).fill(WHITE);
  for (const item of project.strokes) {
    const color = item.erased ? WHITE : item.color;
    for (const cell of item.pixelCells) colors[cell] = color;
  }
  return colors;
}

export function pixelLine(project, frame, from, to, brushSize, cells) {
  const size = project.frameWidth;
  const sheetWidth = size * project.frameCount;
  let [x, y] = from;
  const [endX, endY] = to;
  const dx = Math.abs(endX - x), sx = x < endX ? 1 : -1;
  const dy = Math.abs(endY - y), sy = y < endY ? 1 : -1;
  let error = dx - dy;
  while (true) {
    const left = x - Math.floor(brushSize / 2), top = y - Math.floor(brushSize / 2);
    for (let yy = Math.max(0, top); yy < Math.min(size, top + brushSize); yy++) {
      for (let xx = Math.max(0, left); xx < Math.min(size, left + brushSize); xx++) {
        cells.add(yy * sheetWidth + frame * size + xx);
      }
    }
    if (x === endX && y === endY) break;
    const twice = 2 * error;
    if (twice > -dy) { error -= dy; x += sx; }
    if (twice < dx) { error += dx; y += sy; }
  }
}

export function fillRuns(colors, width, height, startX, startY, replacement) {
  if (colors.length !== width * height || startX < 0 || startX >= width || startY < 0 || startY >= height) {
    throw new Error("Invalid fill coordinates.");
  }
  const source = colors[startY * width + startX];
  if (source === replacement) return [];
  const seen = new Uint8Array(colors.length), queue = [startY * width + startX], runs = [];
  for (let head = 0; head < queue.length; head++) {
    const seed = queue[head];
    if (seen[seed] || colors[seed] !== source) continue;
    const y = Math.floor(seed / width), row = y * width;
    let left = seed % width, right = left;
    while (left > 0 && !seen[row + left - 1] && colors[row + left - 1] === source) left--;
    while (right + 1 < width && !seen[row + right + 1] && colors[row + right + 1] === source) right++;
    seen.fill(1, row + left, row + right + 1);
    runs.push([y, left, right + 1]);
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const next = ny * width;
      for (let x = left; x <= right;) {
        if (!seen[next + x] && colors[next + x] === source) {
          queue.push(next + x);
          do { x++; } while (x <= right && !seen[next + x] && colors[next + x] === source);
        } else x++;
      }
    }
  }
  return runs;
}

export function pixelFill(project, frame, x, y, color) {
  const size = project.frameWidth, sheetWidth = size * project.frameCount, all = pixelColors(project);
  const frameColors = new Int32Array(size * size);
  for (let row = 0; row < size; row++) {
    frameColors.set(all.subarray(row * sheetWidth + frame * size, row * sheetWidth + (frame + 1) * size), row * size);
  }
  return fillRuns(frameColors, size, size, x, y, color).flatMap(([row, left, right]) =>
    Array.from({ length: right - left }, (_, i) => row * sheetWidth + frame * size + left + i));
}

export function copySelection(project, frame, selection) {
  const all = pixelColors(project), size = project.frameWidth, width = size * project.frameCount;
  const colors = [];
  for (let y = 0; y < selection.height; y++) {
    for (let x = 0; x < selection.width; x++) {
      colors.push(all[(selection.y + y) * width + frame * size + selection.x + x]);
    }
  }
  return { ...selection, colors };
}

export function selectionEdits(project, frame, copy, target, source = null) {
  const group = crypto.randomUUID(), width = project.frameWidth * project.frameCount;
  const offset = frame * project.frameWidth, edits = [], groups = new Map();
  if (source) {
    const cells = [];
    for (let y = source.y; y < source.y + source.height; y++) {
      for (let x = source.x; x < source.x + source.width; x++) cells.push(y * width + offset + x);
    }
    edits.push(stroke(WHITE, { erased: true, pixelCells: cells, editGroup: group }));
  }
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      const color = copy.colors[y * copy.width + x];
      if (color === WHITE || (color >>> 24) === 0) continue;
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push((target.y + y) * width + offset + target.x + x);
    }
  }
  for (const [color, cells] of groups) edits.push(stroke(color, { pixelCells: cells, editGroup: group }));
  return edits;
}
