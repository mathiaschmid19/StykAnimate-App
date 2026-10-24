#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProjectSession, SessionError } from './session.mjs';

/** Build the server around one session. Exported so tests can attach any transport. */
export function createServer(session = new ProjectSession({ root: process.env.STYK_MCP_DIR || process.cwd() })) {
  const server = new McpServer({ name: 'stykanimate', version: '0.1.0' }, {
    instructions: [
      'Edits StykAnimate stick-figure animation projects (.styk files) headlessly. Use render_frame to look at the result.',
      'Coordinates are canvas pixels: x grows right, y grows down. Angles are degrees.',
      'Start with new_project or open_project, add figures, then for each pose: add_key at its frame and pose the joints. Finish with save_project.',
      'Call describe_scene after edits to see where every joint ended up.',
    ].join(' '),
  });

  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  const failure = (error) => ({ isError: true, content: [{ type: 'text', text: error.message }] });
  /** Wrap a handler so expected failures come back as readable tool errors. */
  const tool = (name, config, handler) => server.registerTool(name, config, async (args) => {
    try { const result = await handler(args ?? {}); return result?.content ? result : text(result); }
    catch (error) { if (error instanceof SessionError) return failure(error); throw error; }
  });
  const uid = z.number().int().describe('Figure uid, from describe_scene or add_figure');
  const joint = z.union([z.string(), z.number().int()]).describe('Joint name such as "Left forearm", or its numeric segment id');

  tool('new_project', {
    description: 'Start a new project with one default stick figure (Blue). Discards the open project; save first if needed.',
    inputSchema: {
      name: z.string().optional(),
      width: z.number().int().min(1).max(100000).optional().describe('Canvas width in pixels (default 960)'),
      height: z.number().int().min(1).max(100000).optional().describe('Canvas height in pixels (default 540)'),
      fps: z.number().int().min(1).max(1000).optional().describe('Frames per second (default 24)'),
    },
  }, (args) => session.newProject(args));

  tool('open_project', {
    description: 'Open a .styk project from the project folder. Pivot (.piv/.stk) files are not supported by this server yet.',
    inputSchema: { path: z.string() },
  }, ({ path: file }) => session.open(file));

  tool('save_project', {
    description: 'Save the project as .styk. Omit path to save to the file it was opened from or last saved to.',
    inputSchema: { path: z.string().optional() },
  }, ({ path: file }) => session.save(file));

  tool('project_info', {
    description: 'Project name, file, canvas size, frame rate, length, current frame, key frames and unsaved-changes flag.',
  }, () => session.info());

  tool('list_figure_types', {
    description: 'Figure types available to add_figure, with their joint names.',
  }, () => session.figureTypes());

  tool('describe_scene', {
    description: 'Every figure at a frame (default: the current one) with each joint\'s start/end position in canvas pixels and angle in degrees.',
    inputSchema: { frame: z.number().int().min(0).optional() },
  }, ({ frame }) => session.describe(frame));

  tool('render_frame', {
    description: 'Draw a frame (default: the current one) and return it as an image so you can see the animation. Uses the same renderer as the app\'s SVG export. Use a smaller width to save tokens.',
    inputSchema: {
      frame: z.number().int().min(0).optional(),
      width: z.number().int().min(64).max(4000).optional().describe('Image width in pixels (default: 640)'),
    },
  }, async ({ frame, width = 640 }) => {
    const image = await session.renderFrame({ frame, width });
    return { content: [
      { type: 'image', data: Buffer.from(image.png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `Frame ${image.frame} at ${image.width}x${image.height}` },
    ] };
  });

  tool('export_frames', {
    description: 'Write a range of frames as numbered PNG files (frame_0000.png, ...) into a folder inside the project folder. Combine them into a video or GIF with a tool such as ffmpeg: ffmpeg -framerate <fps> -i frame_%04d.png out.mp4',
    inputSchema: {
      folder: z.string().describe('Folder name inside the project folder'),
      start: z.number().int().min(0).optional(),
      end: z.number().int().min(0).optional().describe('Last frame (default: the last frame of the project)'),
      width: z.number().int().min(64).max(4000).optional().describe('Image width in pixels (default: the canvas width)'),
    },
  }, (args) => session.exportFrames(args));

  tool('add_figure', {
    description: 'Add a figure to the current frame. Returns its uid.',
    inputSchema: { figure_type_id: z.number().int().optional().describe('From list_figure_types; defaults to the first') },
  }, ({ figure_type_id }) => session.addFigure(figure_type_id));

  tool('delete_figure', {
    description: 'Remove a figure from the current frame.',
    inputSchema: { uid },
  }, ({ uid: id }) => session.deleteFigure(id));

  tool('pose_joint', {
    description: 'Drag a joint\'s end to canvas position (x, y) at the current frame; connected joints follow as in the editor. Returns the updated scene.',
    inputSchema: { uid, joint, x: z.number(), y: z.number(), stretch: z.boolean().optional().describe('Allow the limb to change length') },
  }, (args) => session.poseJoint(args));

  tool('rotate_joint', {
    description: 'Rotate a joint by a number of degrees (positive is clockwise on screen). Returns the updated scene.',
    inputSchema: { uid, joint, degrees: z.number() },
  }, (args) => session.rotateJoint(args));

  tool('move_figure', {
    description: 'Move a whole figure by (dx, dy) pixels at the current frame. Returns the updated scene.',
    inputSchema: { uid, dx: z.number(), dy: z.number() },
  }, (args) => session.moveFigure(args));

  tool('go_to_frame', {
    description: 'Show a frame (0-based). Pose and move edits apply to the key held at the current frame.',
    inputSchema: { frame: z.number().int().min(0) },
  }, ({ frame }) => session.goToFrame(frame));

  tool('add_key', {
    description: 'Start a new pose at a frame (default: the current one). It begins as a copy of what is showing, then pose it. Frames past the end extend the project. Keys before it tween into it unless interpolation is "hold".',
    inputSchema: {
      frame: z.number().int().min(0).optional(),
      interpolation: z.enum(['linear', 'auto', 'hold']).optional().describe('Motion from the previous key: linear (default), auto (eased), or hold (snap)'),
    },
  }, (args) => session.addKey(args));

  tool('set_length', {
    description: 'Set the animation length in frames, adding held frames at the end or trimming it.',
    inputSchema: { frames: z.number().int().min(1) },
  }, ({ frames }) => session.setLength(frames));

  tool('set_fps', {
    description: 'Set the project frame rate.',
    inputSchema: { fps: z.number().int().min(1).max(1000) },
  }, ({ fps }) => session.setFps(fps));

  tool('set_canvas_size', {
    description: 'Set the canvas size in pixels.',
    inputSchema: { width: z.number().int().min(1).max(100000), height: z.number().int().min(1).max(100000) },
  }, ({ width, height }) => session.setCanvasSize(width, height));

  tool('undo', { description: 'Undo the last edit.' }, () => session.undo());
  tool('redo', { description: 'Redo the last undone edit.' }, () => session.redo());

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createServer().connect(new StdioServerTransport());
}
