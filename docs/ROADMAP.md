# Later milestones

The current milestone tests code, preview, timeline, reusable parameters, and local Windows project editing.

## Basic editor growth

- Real image/video/audio import, source-media timing and missing-file handling.
- Reliable rendering/export, followed by transitions, keyframes, track organization and multi-selection.
- Further usability work guided by hands-on Windows testing, including mixed display scaling, IME input and accessibility.

## Community extensions

After the basic document and rendering contracts settle, define a versioned plugin API for effects, templates, tools and eventually import/export providers. Keep the core document engine, renderer and native host separate. Add permission boundaries, compatibility checks, example plugins and developer documentation before enabling third-party code. Select an explicit source-code license before inviting community reuse.

No plugin loader or public extension API is implemented yet.

## Connect an AI agent

Requested for a later milestone. Explore an explicit connection to the user's chosen agent, with bounded project context and structured editing commands using the same document/history operations as the UI. Design visible proposed changes, apply/undo behavior, permissions and protocol compatibility before implementing it.

No model provider, API-key setup, agent endpoint, background listener or remote execution capability has been added in this prototype.
