import fs from 'node:fs/promises';
import path from 'node:path';
import { Editor } from '../src/editor.mjs';
import { exportSVG } from '../src/svg-export.mjs';
import { buildContainerV2, decodeDocument, normalizeDecodedDocument } from '../src/native-container.mjs';

const RAD = Math.PI / 180;
const MAX_EXPORT_FRAMES = 1000;

/** The app's bundled SVG rasterizer, loaded once. */
let resvgReady;
function loadResvg() {
  resvgReady ??= (async () => {
    const resvg = await import('../vendor/resvg/index.mjs');
    await resvg.initWasm(await fs.readFile(new URL('../vendor/resvg/index_bg.wasm', import.meta.url)));
    return resvg;
  })();
  return resvgReady;
}
const round = (value) => Math.round(value * 100) / 100;

/** A failure the assistant can act on: bad arguments, not a crash. */
export class SessionError extends Error {}

/** One open project and the operations an assistant may perform on it.
 * Everything goes through the same Editor commands the app uses, so history,
 * validation and the saved file match what the interface would produce. */
export class ProjectSession {
  constructor({ root = process.cwd() } = {}) {
    this.root = path.resolve(root);
    // The same configuration the app builds, so frames and keys behave as in its timeline.
    this.editor = new Editor({ demo: false, propertyChannels: true, layerTimeline: true });
    this.editor.newDocument();
    this.path = null;
  }

  /** Project files are confined to the root so a prompt cannot reach elsewhere. */
  resolvePath(file) {
    if (typeof file !== 'string' || !file) throw new SessionError('Provide a project file path.');
    const resolved = path.resolve(this.root, file);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new SessionError(`Project files must stay inside ${this.root}.`);
    if (path.extname(resolved).toLowerCase() !== '.styk')
      throw new SessionError('Project files use the .styk extension.');
    return resolved;
  }

  newProject({ name, width, height, fps } = {}) {
    const { editor } = this;
    editor.newDocument();
    if (name) editor.name = name;
    if (width !== undefined || height !== undefined)
      editor.setCanvasSize(width ?? editor.report.canvas_width, height ?? editor.report.canvas_height);
    if (fps !== undefined) editor.setFPS(fps);
    this.path = null;
    editor.markSaved();
    return this.info();
  }

  async open(file) {
    const target = this.resolvePath(file);
    let bytes;
    try { bytes = await fs.readFile(target); }
    catch (error) { throw new SessionError(`Cannot read ${path.relative(this.root, target)}: ${error.code ?? error.message}`); }
    const decoded = await decodeDocument(bytes, 'styk');
    this.editor.load(normalizeDecodedDocument(decoded.document, 'styk'), path.basename(target));
    this.path = target;
    return this.info();
  }

  /** Atomic like the app's own saves: a failed write leaves the old file intact. */
  async save(file) {
    const target = file ? this.resolvePath(file) : this.path;
    if (!target) throw new SessionError('This project has no file yet. Provide a path ending in .styk.');
    const bytes = await buildContainerV2(this.editor.serialize(), 'styk');
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    this.path = target;
    this.editor.markSaved();
    return { path: path.relative(this.root, target), bytes: bytes.byteLength };
  }

  /** Layers whose keys make up a scene frame (the camera and scene tracks are left alone). */
  get layerIds() { return [...this.editor.report._styk.layers.order]; }

  /** Frames, 0-based, that hold a key on any layer. */
  keyFrames() {
    const ticks = new Set();
    for (const id of this.layerIds) for (const key of this.editor.layerFrameKeys(id)) ticks.add(key.tick);
    return [...ticks].sort((a, b) => a - b);
  }

  info() {
    const { editor } = this;
    const { report } = editor;
    return {
      name: editor.name,
      file: this.path ? path.relative(this.root, this.path) : null,
      unsavedChanges: editor.dirty,
      canvas: { width: report.canvas_width, height: report.canvas_height },
      fps: report.fps,
      lengthFrames: editor.totalTicks,
      currentFrame: editor.tick,
      keyFrames: this.keyFrames(),
    };
  }

  figureTypes() {
    return this.editor.report.figure_types.map((figure) => ({
      id: figure.figure_type_id,
      name: figure.name,
      joints: figure.segments.map((segment) => segment.name),
    }));
  }

  /** Where every part of every figure is in the current frame, in canvas pixels. */
  describe(frame) {
    if (frame !== undefined) this.goToFrame(frame);
    const { editor } = this;
    const figures = [];
    for (const entry of editor.geometry.objects.values()) {
      const uid = entry.obj.unique_id;
      const parts = entry.segments.map((part) => ({
        joint: part.seg.name ?? `segment ${part.seg.segment_id}`,
        type: part.type,
        from: { x: round(part.start.x), y: round(part.start.y) },
        to: { x: round(part.end.x), y: round(part.end.y) },
        angleDegrees: round(part.angle / RAD),
      }));
      figures.push({
        uid,
        figureType: entry.fig.name,
        selected: uid === editor.selectedUid,
        root: { x: round(entry.root.x), y: round(entry.root.y) },
        scale: entry.obj.scale,
        parts,
      });
    }
    return { frame: editor.tick, canvas: { width: editor.report.canvas_width, height: editor.report.canvas_height }, figures };
  }

  /** Draw a frame exactly as the app's SVG export does, then rasterize it to PNG. */
  async renderFrame({ frame, width } = {}) {
    if (frame !== undefined) this.goToFrame(frame);
    const { editor } = this;
    const canvas = editor.report;
    const svg = await exportSVG({
      report: canvas, frame: editor.evaluatedFrame, frameIndex: editor.frameIndex, geometry: editor.geometry,
      width: canvas.canvas_width, height: canvas.canvas_height,
    });
    const { Resvg } = await loadResvg();
    const image = new Resvg(typeof svg === 'string' ? svg : await svg.text(), {
      fitTo: { mode: 'width', value: width ?? canvas.canvas_width },
    }).render();
    return { frame: editor.tick, width: image.width, height: image.height, png: image.asPng() };
  }

  /** Write numbered PNGs to a folder inside the project folder, e.g. for ffmpeg or an image viewer. */
  async exportFrames({ folder, start = 0, end, width } = {}) {
    const { editor } = this;
    const last = end ?? editor.totalTicks - 1;
    if (typeof folder !== 'string' || !folder) throw new SessionError('Provide a folder name.');
    const directory = path.resolve(this.root, folder);
    const relative = path.relative(this.root, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new SessionError(`The folder must be inside ${this.root}.`);
    if (!Number.isInteger(start) || !Number.isInteger(last) || start < 0 || last < start || last >= editor.totalTicks)
      throw new SessionError(`Frames must satisfy 0 <= start <= end < ${editor.totalTicks}.`);
    if (last - start + 1 > MAX_EXPORT_FRAMES) throw new SessionError(`Export at most ${MAX_EXPORT_FRAMES} frames at a time.`);
    await fs.mkdir(directory, { recursive: true });
    const resume = editor.tick;
    try {
      for (let frame = start; frame <= last; frame++) {
        const { png } = await this.renderFrame({ frame, width });
        await fs.writeFile(path.join(directory, `frame_${String(frame).padStart(4, '0')}.png`), png);
      }
    } finally { editor.seek(resume); }
    return { folder: relative, frames: last - start + 1, fps: editor.report.fps, firstFile: `frame_${String(start).padStart(4, '0')}.png` };
  }

  figure(uid) {
    const object = this.editor.evaluatedFrame.objects.find((candidate) => candidate.unique_id === uid);
    if (!object) {
      const known = this.editor.evaluatedFrame.objects.map((candidate) => candidate.unique_id).join(', ');
      throw new SessionError(`No figure with uid ${uid} at this frame. Figures here: ${known || 'none'}.`);
    }
    const type = this.editor.report.figure_types.find((candidate) => candidate.figure_type_id === object.figure_type_id);
    return { object, type };
  }

  /** A joint is its segment name ("Left forearm", case-insensitive) or its numeric segment id. */
  jointIndex(type, joint) {
    const index = typeof joint === 'number'
      ? type.segments.findIndex((segment) => segment.segment_id === joint)
      : type.segments.findIndex((segment) => segment.name?.toLowerCase() === String(joint).toLowerCase());
    if (index < 0)
      throw new SessionError(`${type.name} has no joint "${joint}". Joints: ${type.segments.map((s) => `${s.name} (${s.segment_id})`).join(', ')}.`);
    return index;
  }

  addFigure(figureTypeId) {
    const before = new Set(this.editor.evaluatedFrame.objects.map((object) => object.unique_id));
    try { this.editor.addFigure(figureTypeId); }
    catch (error) { throw new SessionError(error.message); }
    const added = this.editor.evaluatedFrame.objects.find((object) => !before.has(object.unique_id));
    return { uid: added?.unique_id ?? this.editor.selectedUid };
  }

  /** Drag the end of a joint to canvas position (x, y), as dragging its handle would. */
  poseJoint({ uid, joint, x, y, stretch = false }) {
    const { object, type } = this.figure(uid);
    const index = this.jointIndex(type, joint);
    this.editor.select(object.unique_id, index);
    try { this.editor.poseJoint(x, y, { stretch }); }
    catch (error) { throw new SessionError(error.message); }
    return this.describe();
  }

  rotateJoint({ uid, joint, degrees }) {
    const { object, type } = this.figure(uid);
    this.editor.select(object.unique_id, this.jointIndex(type, joint));
    try { this.editor.rotateJoint(degrees * RAD); }
    catch (error) { throw new SessionError(error.message); }
    return this.describe();
  }

  moveFigure({ uid, dx, dy }) {
    const { object } = this.figure(uid);
    this.editor.select(object.unique_id);
    try { this.editor.moveSelection(dx, dy); }
    catch (error) { throw new SessionError(error.message); }
    return this.describe();
  }

  deleteFigure(uid) {
    const { object } = this.figure(uid);
    this.editor.select(object.unique_id);
    this.editor.deleteSelection();
    return this.describe();
  }

  /** Show a frame (0-based). Joint edits apply to the key held at the current frame. */
  goToFrame(frame) {
    const { editor } = this;
    if (!Number.isInteger(frame) || frame < 0 || frame >= editor.totalTicks)
      throw new SessionError(`Frame ${frame} is outside this project, which has ${editor.totalTicks} frames (0-${editor.totalTicks - 1}). Use set_length or add_key to extend it.`);
    editor.seek(frame);
    return this.info();
  }

  /** Start a new pose at a frame (default: the current one) on every layer, extending the project
   * if the frame is past its end. The pose begins as a copy of what is showing there. It eases in
   * from the previous key using `interpolation`: 'linear' and 'auto' tween, 'hold' snaps. */
  addKey({ frame = this.editor.tick, interpolation = 'linear' } = {}) {
    const { editor } = this;
    if (!Number.isInteger(frame) || frame < 0) throw new SessionError('Frame must be a whole number, 0 or more.');
    const previous = this.keyFrames().filter((tick) => tick < frame).at(-1);
    try {
      editor.seek(frame, { allowBeyondEnd: true });
      editor.sheetInsertKey(this.layerIds, frame);
      if (previous !== undefined) editor.sheetSetEasing(this.layerIds, previous, previous, { interpolation });
      editor.seek(frame);
    } catch (error) { throw new SessionError(error.message); }
    return this.info();
  }

  /** Make the whole animation exactly this many frames long. */
  setLength(frames) {
    const { editor } = this;
    if (!Number.isInteger(frames) || frames < 1) throw new SessionError('Length must be a whole number of frames, 1 or more.');
    const current = editor.totalTicks;
    const ids = ['scene', 'camera', ...this.layerIds];
    try {
      if (frames > current) editor.sheetInsertFrames(ids, current, frames - current);
      else if (frames < current) editor.sheetRemoveFrames(ids, frames, current - 1);
      editor.seek(Math.min(editor.tick, frames - 1));
    } catch (error) { throw new SessionError(error.message); }
    return this.info();
  }

  setFps(fps) {
    try { this.editor.setFPS(fps); }
    catch (error) { throw new SessionError(error.message); }
    return this.info();
  }

  setCanvasSize(width, height) {
    try { this.editor.setCanvasSize(width, height); }
    catch (error) { throw new SessionError(error.message); }
    return this.info();
  }

  undo() { return { undone: Boolean(this.editor.undo()), ...this.info() }; }

  redo() { return { redone: Boolean(this.editor.redo()), ...this.info() }; }
}
