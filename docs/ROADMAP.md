# Later milestones

The current milestone adds real video import, decode, seek and muted preview playback on top of code, preview, timeline, reusable parameters, and local Windows project editing.

## Basic editor growth

Implemented: image import with authorized serving and missing-file handling, and M1 video import — container probing, authorized range serving, timeline placement, real decoded frames, seek, and muted playback in the preview (0.4.0). A project that uses media is readable only by 0.4 and later; older builds refuse it instead of opening it and later dropping the media.

Still ahead:

- Audio playback, gain and waveform controls, video/audio synchronization, loop-safe audio, and the remaining media work: media-specific trim/split coverage, codec rejection, and long-file/scrubbing hardening.
- Rendered video/audio export (Stage 8), followed by transitions, keyframes and fuller track organization. Multi-selection/group movement, basic layer controls and preview transforms are implemented in 0.3.0.
- Further usability work guided by hands-on Windows testing, including mixed display scaling, IME input and accessibility.

## Community extensions

After the basic document and rendering contracts settle, define a versioned plugin API for effects, templates, tools and eventually import/export providers. Keep the core document engine, renderer and native host separate. Add permission boundaries, compatibility checks, example plugins and developer documentation before enabling third-party code. Select an explicit source-code license before inviting community reuse.

No plugin loader or public extension API is implemented yet.

## Connect an AI agent

Requested for a later milestone. Explore an explicit connection to the user's chosen agent, with bounded project context and structured editing commands using the same document/history operations as the UI. Design visible proposed changes, apply/undo behavior, permissions and protocol compatibility before implementing it.

No model provider, API-key setup, agent endpoint, background listener or remote execution capability has been added in this prototype.
