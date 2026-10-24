import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectSession, SessionError } from '../session.mjs';

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'styk-mcp-'));
  return { root, session: new ProjectSession({ root }), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const part = (scene, uid, joint) => scene.figures.find((f) => f.uid === uid).parts.find((p) => p.joint === joint);

test('a new project starts with one figure and the requested settings', async () => {
  const { session, cleanup } = await workspace();
  try {
    const info = session.newProject({ name: 'Walk', width: 1280, height: 720, fps: 12 });
    assert.deepEqual(info.canvas, { width: 1280, height: 720 });
    assert.equal(info.fps, 12);
    assert.deepEqual(info.keyFrames, [0]);
    assert.equal(session.describe().figures.length, 1);
  } finally { await cleanup(); }
});

test('pose_joint moves the joint end to the requested point and undo restores it', async () => {
  const { session, cleanup } = await workspace();
  try {
    const [figure] = session.describe().figures;
    const before = part(session.describe(), figure.uid, 'Left forearm').to;
    const scene = session.poseJoint({ uid: figure.uid, joint: 'left forearm', x: 540, y: 215 });
    const end = part(scene, figure.uid, 'Left forearm').to;
    assert.ok(Math.hypot(end.x - 540, end.y - 215) < 1, `forearm ended at ${end.x},${end.y}`);
    assert.equal(session.undo().undone, true);
    assert.deepEqual(part(session.describe(), figure.uid, 'Left forearm').to, before);
  } finally { await cleanup(); }
});

test('a key at a later frame poses it without touching the first, and tweens between them', async () => {
  const { session, cleanup } = await workspace();
  try {
    const [figure] = session.describe().figures;
    const start = part(session.describe(), figure.uid, 'Right forearm').to;
    session.addKey({ frame: 12 });
    assert.deepEqual(session.info().keyFrames, [0, 12]);
    assert.equal(session.info().lengthFrames, 13, 'adding a key past the end extends the project');
    session.poseJoint({ uid: figure.uid, joint: 'Right forearm', x: 410, y: 180 });
    const posed = part(session.describe(12), figure.uid, 'Right forearm').to;
    assert.ok(Math.hypot(posed.x - 410, posed.y - 180) < 1);
    assert.deepEqual(part(session.describe(0), figure.uid, 'Right forearm').to, start);
    const middle = part(session.describe(6), figure.uid, 'Right forearm').to;
    assert.notDeepEqual(middle, start);
    assert.notDeepEqual(middle, posed);
  } finally { await cleanup(); }
});

test('hold interpolation snaps instead of tweening', async () => {
  const { session, cleanup } = await workspace();
  try {
    const [figure] = session.describe().figures;
    const start = part(session.describe(), figure.uid, 'Right forearm').to;
    session.addKey({ frame: 10, interpolation: 'hold' });
    session.poseJoint({ uid: figure.uid, joint: 'Right forearm', x: 410, y: 180 });
    assert.deepEqual(part(session.describe(5), figure.uid, 'Right forearm').to, start);
  } finally { await cleanup(); }
});

test('set_length grows and trims the animation', async () => {
  const { session, cleanup } = await workspace();
  try {
    assert.equal(session.setLength(48).lengthFrames, 48);
    assert.equal(session.setLength(20).lengthFrames, 20);
    assert.throws(() => session.goToFrame(20), SessionError);
    assert.equal(session.goToFrame(19).currentFrame, 19);
  } finally { await cleanup(); }
});

test('adding and moving figures', async () => {
  const { session, cleanup } = await workspace();
  try {
    const { uid } = session.addFigure();
    assert.equal(session.describe().figures.length, 2);
    const root = session.describe().figures.find((f) => f.uid === uid).root;
    const moved = session.moveFigure({ uid, dx: 40, dy: -10 });
    const next = moved.figures.find((f) => f.uid === uid).root;
    assert.deepEqual([next.x - root.x, next.y - root.y], [40, -10]);
    session.deleteFigure(uid);
    assert.equal(session.describe().figures.length, 1);
  } finally { await cleanup(); }
});

test('save then open restores length, fps, keys and poses', async () => {
  const { session, root, cleanup } = await workspace();
  try {
    session.newProject({ fps: 30 });
    const [figure] = session.describe().figures;
    session.addKey({ frame: 8 });
    session.poseJoint({ uid: figure.uid, joint: 'Left forearm', x: 545, y: 160 });
    const saved = await session.save('anim/pose.styk');
    assert.equal(saved.path, path.join('anim', 'pose.styk'));
    assert.equal(session.info().unsavedChanges, false);

    const other = new ProjectSession({ root });
    const info = await other.open('anim/pose.styk');
    assert.equal(info.fps, 30);
    assert.deepEqual(info.keyFrames, [0, 8]);
    assert.equal(info.lengthFrames, 10);
    const end = part(other.describe(8), figure.uid, 'Left forearm').to;
    assert.ok(Math.hypot(end.x - 545, end.y - 160) < 1);
    assert.deepEqual(await fs.readdir(path.join(root, 'anim')), ['pose.styk'], 'no temporary file is left behind');
  } finally { await cleanup(); }
});

test('bad requests come back as errors the assistant can read', async () => {
  const { session, cleanup } = await workspace();
  try {
    assert.throws(() => session.poseJoint({ uid: 999, joint: 'Head', x: 1, y: 1 }), (e) => e instanceof SessionError && /No figure with uid 999/.test(e.message));
    const [figure] = session.describe().figures;
    assert.throws(() => session.rotateJoint({ uid: figure.uid, joint: 'Tail', degrees: 5 }), (e) => e instanceof SessionError && /Left forearm/.test(e.message));
    assert.throws(() => session.goToFrame(500), /outside this project/);
    assert.throws(() => session.setFps(0), SessionError);
    assert.throws(() => session.resolvePath('../escape.styk'), /inside/);
    assert.throws(() => session.resolvePath('/etc/passwd.styk'), /inside/);
    assert.throws(() => session.resolvePath('notes.txt'), /\.styk/);
    await assert.rejects(session.save(), /no file yet/);
    await assert.rejects(session.open('missing.styk'), SessionError);
  } finally { await cleanup(); }
});

test('rendering returns a PNG that changes as the animation moves', async () => {
  const { session, cleanup } = await workspace();
  try {
    const [figure] = session.describe().figures;
    session.addKey({ frame: 12 });
    session.poseJoint({ uid: figure.uid, joint: 'Right forearm', x: 410, y: 180 });
    const first = await session.renderFrame({ frame: 0, width: 320 });
    const middle = await session.renderFrame({ frame: 6, width: 320 });
    const last = await session.renderFrame({ frame: 12, width: 320 });
    assert.deepEqual([...first.png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
    assert.equal(first.width, 320);
    assert.notDeepEqual(first.png, middle.png);
    assert.notDeepEqual(middle.png, last.png);
  } finally { await cleanup(); }
});

test('export_frames writes a numbered PNG sequence and keeps the playhead', async () => {
  const { session, root, cleanup } = await workspace();
  try {
    session.addKey({ frame: 3 });
    session.goToFrame(2);
    const result = await session.exportFrames({ folder: 'out/walk', start: 0, end: 3, width: 160 });
    assert.equal(result.frames, 4);
    assert.deepEqual(await fs.readdir(path.join(root, 'out/walk')), ['frame_0000.png', 'frame_0001.png', 'frame_0002.png', 'frame_0003.png']);
    assert.equal(session.info().currentFrame, 2);
    await assert.rejects(session.exportFrames({ folder: '../outside' }), /inside/);
    await assert.rejects(session.exportFrames({ folder: 'x', start: 5, end: 2 }), SessionError);
  } finally { await cleanup(); }
});
