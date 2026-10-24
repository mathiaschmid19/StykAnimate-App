# StykAnimate MCP server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant such as Claude create and edit StykAnimate projects. It runs the app's own `Editor` (`src/editor.mjs`) without a window or GPU, so poses, keys, undo and `.styk` files behave exactly as they do in the app.

Everything stays on your machine: the server talks to its client over stdio and only reads and writes `.styk` files inside one project folder.

## Set up

Node.js 22 or newer.

```sh
cd mcp
npm ci
```

Register it with Claude Code (run from the folder where your animations should live, or set `STYK_MCP_DIR`):

```sh
claude mcp add stykanimate -- node /absolute/path/to/StykAnimate-App/mcp/server.mjs
```

For Claude Desktop, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stykanimate": {
      "command": "node",
      "args": ["/absolute/path/to/StykAnimate-App/mcp/server.mjs"],
      "env": { "STYK_MCP_DIR": "/absolute/path/to/your/animations" }
    }
  }
}
```

`STYK_MCP_DIR` is the project folder (default: the working directory). Paths passed to the tools are relative to it and cannot leave it.

## Model

Coordinates are canvas pixels (x right, y down) and angles are degrees. Time is frames, counted from 0, as in the app's timeline. A **key** is a pose that holds until the next key. Pose and move tools edit the key held at the current frame, so the workflow for each pose is `add_key` at its frame, then pose the joints. Keys tween into each other (`linear` by default; `auto` eases, `hold` snaps).

Limbs keep their length, so `pose_joint` stops where the chain can reach; `describe_scene` shows where each joint actually ended up.

## Tools

| Tool | Purpose |
| --- | --- |
| `new_project`, `open_project`, `save_project`, `project_info` | Project files and state. Opening and saving use `.styk`. |
| `list_figure_types`, `add_figure`, `delete_figure` | Figures in the project. |
| `describe_scene` | Every joint's position and angle at a frame. |
| `render_frame` | Returns a frame as an image, so the assistant can see what it made. |
| `export_frames` | Writes numbered PNGs to a folder, ready for ffmpeg or an image viewer. |
| `pose_joint`, `rotate_joint`, `move_figure` | Edit the pose at the current frame. |
| `go_to_frame`, `add_key`, `set_length` | Timeline. |
| `set_fps`, `set_canvas_size`, `undo`, `redo` | Project settings and history. |

## Seeing the result

- **In the conversation:** `render_frame` returns a frame as an image, drawn by the app's own SVG export and rasterized with the bundled resvg. It needs no browser, GPU or Python, so the assistant can pose, look and adjust.
- **As a video or GIF:** `export_frames` writes `frame_0000.png`, `frame_0001.png`, ... and you combine them yourself, for example `ffmpeg -framerate 24 -i frame_%04d.png out.mp4`.
- **In the real editor:** run `npm run serve` from the repository root, open http://127.0.0.1:47831 and open the saved `.styk`. Use this for the app's own preview and its MP4, WebM and GIF exports.

Renders match the app's vector export, not its WebGPU view, so antialiasing and some effects can differ slightly.

## Limits

- Pivot (`.piv`, `.stk`) import and the app's own video export need its Python and FFmpeg services and are not part of this server. Save a `.styk` and use the editor.
- Drawing layers, text, effects, audio and the camera are not exposed.
- The editor does not update live while the assistant works; reopen the saved file to see changes there.

## Tests

```sh
npm --prefix mcp ci
npm run test:mcp
```
