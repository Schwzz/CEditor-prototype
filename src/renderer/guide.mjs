import { DEFAULT_SOURCE } from "../core/engine.mjs";
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const basic = `composition("My first motion").duration(6)
scene("Background").at(0).for(6).look("orbit")
text("Hello").at(0.5).for(5).value("HELLO, FRAMECODE.").motion("rise")`;
export const LESSONS = [
  {
    title: "1. Your first composition",
    intro:
      "A composition is a short set of instructions describing what appears, where it appears, and when it moves.",
    code: basic,
    notes: [
      'composition("Name") names the project. .duration(6) makes it six seconds long.',
      "Each scene(), text(), or shape() statement makes one timeline clip. Its quoted name must be unique.",
      "Dots attach settings to the same clip. Keep each complete statement on one line. This is a small language, not arbitrary JavaScript.",
    ],
    exercise:
      "Load this example, change HELLO, FRAMECODE. to your own message, then press Space outside the editor to play.",
  },
  {
    title: "2. Start, length, and end",
    intro:
      "All timeline times are in seconds. End time equals start plus length.",
    code: basic.replace(".at(0.5).for(5)", ".at(2).for(3)"),
    notes: [
      ".at(2) starts the text at the two-second mark. .for(3) keeps it visible for three seconds: it ends at 5.",
      "The clip must fit inside the composition. Starting at 5 with a length of 3 cannot fit in a six-second project.",
      "Dragging the clip changes .at(). Pulling an edge changes timing. The inspector lets you enter start, end, or length precisely.",
    ],
    exercise:
      "Try moving the text to start at 1 second. Resize its right edge so it ends at 4 seconds.",
  },
  {
    title: "3. Reusable parameters",
    intro:
      "A parameter exposes a value as a template control. A $reference uses that value inside a clip.",
    code: `composition("A reusable title").duration(8)
param("message", "MAKE IT YOURS.")
param("accent", "#d6fa69")
param("tempo", 1)
scene("Background").at(0).for(8).look("orbit")
shape("Signal").at(0).for(8).color($accent).motion("orbit")
text("Title").at(0.5).for(7).value($message).motion("rise")`,
    notes: [
      'param("message", "MAKE IT YOURS.") creates a text control. .value($message) connects the title to it.',
      "A six-digit hex string creates a color control. Numbers create numeric controls; tempo has a slider from 0.2 to 3.",
      "Tempo changes animation speed, while the start and length of clips stay the same. Names use letters, numbers, and underscores, starting with a letter or underscore.",
    ],
    exercise:
      "Change the message using the right panel, then find the updated param() statement in the code.",
  },
  {
    title: "4. Position and the preview",
    intro:
      "The canvas uses a 1920×1080 coordinate system, even when its preview is displayed smaller.",
    code: `composition("Place an idea").duration(8)
scene("Background").at(0).for(8).look("orbit")
shape("Signal").at(0).for(8).color("#d6fa69").position(1400, 550).motion("orbit")
text("Title").at(0.5).for(7).value("MOVE ME.").position(200, 400).motion("rise")`,
    notes: [
      "X increases from left to right. Y increases from top to bottom. .position(200, 400) sets a logical-pixel anchor.",
      "For text, the anchor is the first line’s baseline; centered text uses its center baseline. For a shape it is its center. Motion adds an offset to that base position.",
      "Click or drag an object in the preview. Code and timeline selection follow. Use the X/Y fields, or focus the canvas and use arrow keys (Shift for 10 pixels). Background scenes fill the frame and cannot be moved.",
    ],
    exercise:
      "Drag MOVE ME. to another part of the canvas. Watch .position() update, then Undo the move.",
  },
  {
    title: "5. Placement and motion",
    intro:
      "Placement is a starting layout. Motion describes how an object changes over time.",
    code: `composition("Small motions").duration(8)
scene("Background").at(0).for(8).look("pulse")
text("Title").at(0).for(8).value("FIND YOUR RHYTHM.").place("center").motion("pulse")
text("Caption").at(1).for(6).value("A quieter thought.").place("bottom").motion("fade")`,
    notes: [
      '.place("left"), .place("center"), and .place("bottom") are text presets. Bottom placement also uses a smaller caption font. An explicit .position() overrides preset coordinates.',
      'Motion supports "rise", "fade", "orbit", "pulse", and "none". Rise slides in, fade changes opacity, orbit moves/rotates, pulse changes emphasis, and none stays static.',
      'Scene looks support "orbit", "pulse", or "grid". A shape’s color uses .color("#rrggbb") or a color parameter.',
    ],
    exercise:
      "Try the different motion names one at a time. Seek back toward the clip’s start to see its entrance.",
  },
  {
    title: "6. Layers and selection",
    intro:
      "The order of clip statements determines their visual stacking. Later statements draw in front of earlier ones.",
    code: DEFAULT_SOURCE,
    notes: [
      "Keep a full-frame scene before the objects you want to see over it. A later full-frame scene can cover earlier objects.",
      "Preview clicks select the top visible object under the pointer. Select covered objects through their timeline clip or source line.",
      "Selection is shared. A selected object gets a preview outline, its source line is highlighted, and its timeline clip is outlined. If it is outside the current time, selection seeks into its visible range.",
    ],
    exercise:
      "Select the Caption line, then select Signal from the timeline. Watch the highlight move across the workspace.",
  },
  {
    title: "7. Split and clipboard tools",
    intro:
      "Split divides a clip at the playhead. Cut removes a clip and puts it on the clipboard; these are different operations.",
    code: `composition("One continuous signal").duration(10)
scene("Background").at(0).for(10).look("orbit")
shape("Part one").at(0).for(4).color("#d6fa69").motion("orbit").sourceAt(0).sourceDuration(10)
shape("Part two").at(4).for(6).color("#d6fa69").motion("orbit").sourceAt(4).sourceDuration(10)`,
    notes: [
      "Right-click a clip for Split at playhead, Set timing, Cut, Copy, Paste, Duplicate, and Delete. Shift+F10 also opens its menu.",
      "Splitting writes .sourceAt() and .sourceDuration() to preserve the original animation phase. You usually let the editor create those fields. Trimmed split pieces cannot extend past their source window.",
      "Duplicate keeps parameter references. Clipboard paste imports needed parameters and gives conflicting values new names; it does not change existing template controls. Paste time is clamped so the clip fits.",
    ],
    exercise:
      "Play through the four-second boundary. The second signal continues where the first one stopped.",
  },
  {
    title: "8. Files, recovery, and shortcuts",
    intro:
      "A local project preserves the composition source, parameters, and last valid preview. It does not contain rendered video.",
    code: basic,
    notes: [
      "Ctrl+N creates a project, Ctrl+O opens one, Ctrl+S saves, and Ctrl+Shift+S saves a copy. Unsaved New/Open/Close operations offer Save, Discard, or Cancel.",
      "Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redoes edits across the workspace. Each completed drag is one undo step. Ctrl+F searches code; Ctrl+Enter runs it; F1 opens this guide.",
      "If code is invalid, its error appears while the last valid composition remains visible. Draft recovery is saved locally and offered at the next launch as an unsaved copy. It is not a backup of media files.",
    ],
    exercise:
      "Save a project, change its title, and close the app. Try Cancel first, then Save.",
  },
  {
    title: "9. Language reference",
    intro:
      "Use double-quoted strings, ordinary numbers such as 0.5, and $parameter references. Comments begin with // on their own line.",
    code: DEFAULT_SOURCE,
    notes: [
      'composition("Name").duration(seconds); param("name", "value") or param("name", 1). One composition per file; parameter names are unique.',
      'scene("Name"): .at(), .for(), .look(), .sourceAt(), .sourceDuration(). text("Name") also supports .value(), .place(), .motion(), .position(x,y). shape("Name") supports .color(), .motion(), .position(x,y).',
      "Limits: 1–60 seconds, at most 24 clips, at most 50,000 source characters. Every clip must have positive length and fit inside the composition. Single quotes, functions, loops, imports, and arbitrary JavaScript are not supported.",
    ],
    exercise:
      "Use this reference when an error points to an unsupported method or invalid value.",
  },
];
export function mountGuide({ topics, content, onLoad }) {
  function show(index) {
    const lesson = LESSONS[index];
    topics
      .querySelectorAll("button")
      .forEach((button, i) =>
        button.setAttribute("aria-current", String(i === index)),
      );
    content.innerHTML = `<h3>${escape(lesson.title)}</h3><p>${escape(lesson.intro)}</p><pre><code>${escape(lesson.code)}</code></pre><ul>${lesson.notes.map((note) => "<li>" + escape(note) + "</li>").join("")}</ul><div class="guide-exercise"><strong>Try it</strong><p>${escape(lesson.exercise)}</p></div><button class="button primary" id="loadLesson">Load this example</button><p class="dialog-note">Replaces this composition. Undo restores the previous source.</p>`;
    content.querySelector("#loadLesson").onclick = () => onLoad(lesson.code);
    content.scrollTop = 0;
  }
  LESSONS.forEach((lesson, index) => {
    const button = document.createElement("button");
    button.textContent = lesson.title;
    button.onclick = () => show(index);
    topics.append(button);
  });
  show(0);
}
