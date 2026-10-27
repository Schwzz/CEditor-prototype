# Prototype validation

Validated on 27 October 2026 using Node.js checks and a desktop Chromium browser against the served prototype.

## Automated checks

`npm run check`: syntax checks for the UI module, composition engine, and local server.

`npm test`: 9 engine tests covering all example templates, parameter resolution, source/timing round trips, invalid code rejection, Unicode snapshot encoding, clip visibility boundaries, method-like strings in labels, parameter identifier validation, and names shared with `Object.prototype`.

Three regression tests were observed failing before their fixes and passing afterward.

## Browser interactions

| Interaction | Observed result |
| --- | --- |
| Edit source timing and text | Headline moved to 0.8 seconds with an 8-second duration; template controls and timeline reflected the edited source. |
| Change a template parameter | Title changed to `SWARTZ IN MOTION` in the source and corresponding timeline clip. |
| Inspect a timeline clip | The corresponding source line highlighted and the timing inspector appeared. |
| Select a source line | Moving the source caret to the Signal line selected the corresponding timeline element. |
| Adjust numeric timing | Changing the start with the inspector's number control updated the source. |
| Nudge with keyboard | ArrowRight changed start time by 0.1 seconds and retained clip focus. |
| Drag a timeline clip | Dragging Headline moved its start from 1 to 2 seconds and wrote `.at(2)` to the source. |
| Play and pause | Playhead advanced; Pause stopped playback. |
| Scrub preview | Moving the seek slider to its end set the playhead to 12 seconds. |
| Copy template source | Clipboard text matched the exact snapshot shown in the share dialog. |
| Copy and open remix link | A second tab loaded the correct source and displayed `YOUR EDITABLE COPY`. |
| Edit a remix | Changing the copied title left the original tab's shared snapshot unchanged. |
| Try snapshot as editable copy | The dialog closed and the workspace displayed the editable-copy state. |
| Load a gallery template | After hours loaded its title and composition. |
| Undo template replacement | The previous custom title and source were restored. |
| Save and reload a draft | A custom title survived reload. |
| Invalid code | An unknown function produced a line-specific error and disabled sharing. |
| Reload an invalid draft | The invalid source and error remained, while all four clips from the last valid composition were restored. |
| Reset | The original Orbit study source, controls, timing, and paused preview returned. |

## Limits of verification

Browser interaction checks were manual agent-driven QA, not a committed browser automation suite. Actual mobile devices and other browsers were not tested. Engine tests and syntax checks run in GitHub Actions; this workflow does not deploy a public site or perform browser tests. No media processing or video export is implemented or claimed.
