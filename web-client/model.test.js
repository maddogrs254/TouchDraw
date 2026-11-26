import test from "node:test";
import assert from "node:assert/strict";
import { newProject, validateProject, stroke, WHITE, pixelColors, pixelLine, pixelFill,
  fillRuns, copySelection, selectionEdits } from "./model.js";
import { makeZip } from "./zip.js";

test("pixel strokes and flood fill stay within the selected frame", () => {
  const project = newProject("sprite", true, 16, 2), cells = new Set();
  pixelLine(project, 1, [0, 0], [1, 0], 2, cells);
  assert.deepEqual([...cells].sort((a, b) => a - b), [16, 17]);
  project.strokes.push(stroke(-65536, { pixelCells: [...cells] }));
  const filled = pixelFill(project, 1, 3, 3, -16776961);
  assert.equal(filled.length, 254);
  assert.ok(filled.every(cell => cell % 32 >= 16));
  assert.equal(pixelColors(project)[0], WHITE);
});

test("selection move handles overlap and paste into another frame", () => {
  const project = newProject("sprite", true, 16, 2);
  project.strokes.push(stroke(-65536, { pixelCells: [0] }), stroke(-16776961, { pixelCells: [1] }));
  const source = { x: 0, y: 0, width: 2, height: 1 }, copied = copySelection(project, 0, source);
  project.strokes.push(...selectionEdits(project, 0, copied, { ...source, x: 1 }, source));
  let colors = pixelColors(project);
  assert.deepEqual([...colors.slice(0, 4)], [WHITE, -65536, -16776961, WHITE]);
  const edits = selectionEdits(project, 1, copied, source);
  assert.equal(new Set(edits.map(item => item.editGroup)).size, 1);
  project.strokes.push(...edits); colors = pixelColors(project);
  assert.deepEqual([...colors.slice(16, 18)], [-65536, -16776961]);
});

test("freehand fill encodes only the connected region and remains compact", () => {
  assert.deepEqual(fillRuns(Int32Array.from([1, 0, 1, 1, 0, 1]), 3, 2, 0, 0, 2),
    [[0, 0, 1], [1, 0, 1]]);
  assert.deepEqual(fillRuns(Int32Array.from([1]), 1, 1, 0, 0, 1), []);
  const runs = fillRuns(new Int32Array(2048 * 1536), 2048, 1536, 0, 0, 1);
  assert.equal(runs.length, 1536);
  assert.deepEqual(runs.at(-1), [1535, 0, 2048]);
});

test("project validation supports v1 and v3 and rejects malformed fills", () => {
  const legacy = { version: 1, id: "legacy", name: "Old", strokes: [{ color: -1, width: 2, points: [[0, 1]] }] };
  assert.equal(validateProject(legacy).templateType, "default_freehand");
  const project = newProject("freehand");
  project.version = 3;
  project.strokes.push(stroke(-65536, { fillRuns: [[0, 0, 2048]] }));
  assert.equal(validateProject(project).strokes[0].fillRuns[0][2], 2048);
  project.strokes[0].fillRuns[0][2] = 2049;
  assert.throws(() => validateProject(project), /invalid stroke/);
});

test("ZIP export stores a valid file entry", async () => {
  const file = new File(["hello"], "one.txt"), blob = await makeZip([file]);
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(14, true), 0x3610a686);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
});
