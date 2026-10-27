# CEditor prototype · Framecode

A small, Strudel-inspired experiment in **writing video compositions as code**, seeing the same composition on a timeline, and passing the code along as an editable template.

This is an interaction prototype. It uses a deliberately small motion language and procedural canvas graphics, rather than a full video-editing engine or actual Strudel syntax.

## Try it

Requires Node.js 22 or newer. There are no runtime dependencies and no build step.

```sh
npm start
```

Open `http://localhost:5173`. Serve the files over HTTP; opening `index.html` directly will not load the JavaScript modules correctly.

1. Change `param("title", "MAKE IT MOVE.")` in the code. The preview and timeline text follow automatically.
2. Click the Headline clip. Its source line highlights and the timing inspector appears. Change its start or length, drag it, or use Left/Right to nudge it by 0.1 seconds. The code updates too.
3. Adjust title, subtitle, accent color, and animation tempo using the template controls. Controls are generated from `param()` declarations.
4. Play, pause, loop, jump to the start, or scrub the preview and timeline ruler.
5. Open **Templates** to remix one of three example looks.
6. Open **Share template** to copy the code, copy a remix link, or try the snapshot as an editable copy. A remix link contains a snapshot in the URL fragment; it does not publish anything or grant site access.

Your draft is saved in this browser's local storage. A syntax error keeps the last valid composition visible, including after reload. Resetting or loading a template offers a short-lived Undo action.

## Small motion language

Each statement occupies one line. Use double-quoted strings, numbers, and `$parameter` references. Full-line `//` comments are supported.

```js
composition("Orbit study").duration(12)
param("title", "MAKE IT MOVE.")
param("accent", "#d6fa69")
param("tempo", 1)

scene("Backdrop").at(0).for(12).look("orbit")
text("Headline").at(0.4).for(10.8).value($title).place("left").motion("rise")
shape("Signal").at(0).for(12).color($accent).motion("orbit")
```

| Part | Supported values |
| --- | --- |
| Timing | `.at(startSeconds)` and `.for(durationSeconds)` |
| Text placement | `left`, `center`, `bottom` |
| Motion | `rise`, `fade`, `orbit`, `pulse`, `none` |
| Background look | `orbit`, `pulse`, `grid` |
| Colors | Six-digit hex, e.g. `#d6fa69` |
| Composition limits | 1–60 seconds, up to 24 clips, 50,000 source characters |
| Tempo | 0.2–3; changes motion speed, not clip timing |

The parser validates this restricted language; it never evaluates arbitrary JavaScript. The example renderer demonstrates one active background and one active signal shape, plus text layers. Some motion styles share the same introductory fade; this is not a general animation API.

## Scope

Implemented: live code editing, a linked editable timeline, procedural preview, parameter controls, three example templates, snapshot remixing, local draft persistence, error recovery, and keyboard controls.

Outside this prototype: imported video/images/audio, trimming real media, keyframe editing, waveform editing, video export, cloud project storage, live collaboration, user accounts, and a template marketplace. The deployed preview is owner-private; the GitHub source uses this repository's existing visibility. Local development has no authentication.

## Validation

```sh
npm run check
npm test
```

GitHub Actions runs the syntax checks and engine tests on pushes and pull requests. See [VALIDATION.md](VALIDATION.md) for the interaction checks performed on this prototype.

## Files

- `dist/index.html`, `dist/style.css`: the responsive editing workspace and dialogs.
- `dist/app.mjs`: UI state, canvas preview, timeline, draft storage, and template interactions.
- `dist/engine.mjs`: restricted parser, parameter resolution, source updates, and snapshot encoding.
- `tests/engine.test.mjs`: behavior and regression checks for the composition engine.
- `scripts/serve.mjs`: dependency-free local static server.
- `.openai/hosting.json`: private preview deployment configuration.
