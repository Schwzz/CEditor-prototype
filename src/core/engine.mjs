export const DEFAULT_SOURCE = `// A composition is a small, reusable score.
composition("Orbit study").duration(12)

// These become editable template controls.
param("title", "MAKE IT MOVE.")
param("subtitle", "A small idea. In motion.")
param("accent", "#d6fa69")
param("tempo", 1)

scene("Backdrop").at(0).for(12).look("orbit")
text("Headline").at(0.4).for(10.8).value($title).place("left").motion("rise")
text("Caption").at(1).for(10).value($subtitle).place("bottom").motion("fade")
shape("Signal").at(0).for(12).color($accent).motion("orbit")`;

export const TEMPLATES = [
  {
    name: "Orbit study",
    kind: "orbit",
    description: "Bold type, a looping signal, and a little space.",
    source: DEFAULT_SOURCE,
  },
  {
    name: "Soft frequency",
    kind: "pulse",
    description: "A warm pulse with a quieter rhythm.",
    source: DEFAULT_SOURCE.replace("Orbit study", "Soft frequency")
      .replace("MAKE IT MOVE.", "FIND YOUR FREQUENCY.")
      .replace("A small idea. In motion.", "Tune into something new.")
      .replace("#d6fa69", "#ff997e")
      .replace('param("tempo", 1)', 'param("tempo", 0.7)')
      .replace('.look("orbit")', '.look("pulse")'),
  },
  {
    name: "After hours",
    kind: "grid",
    description: "Electric blue. Precise lines. Late-night energy.",
    source: DEFAULT_SOURCE.replace("Orbit study", "After hours")
      .replace("MAKE IT MOVE.", "AFTER HOURS.")
      .replace("A small idea. In motion.", "Ideas don’t keep office hours.")
      .replace("#d6fa69", "#96b9ff")
      .replace('.look("orbit")', '.look("grid")'),
  },
];

function fail(line, message) {
  const e = new Error(message);
  e.line = line;
  throw e;
}
function parseArg(raw, line) {
  const value = raw.trim();
  if (/^\$[A-Za-z_][\w]*$/.test(value)) return { ref: value.slice(1) };
  try {
    const result = JSON.parse(value);
    if (typeof result === "string" || typeof result === "number") return result;
  } catch {}
  fail(line, "Use a quoted string, a number, or a $parameter.");
}
function splitArgs(input, line) {
  if (!input.trim()) return [];
  const out = [];
  let start = 0,
    quote = false,
    escape = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && quote) {
      escape = true;
      continue;
    }
    if (c === '"') quote = !quote;
    if (c === "," && !quote) {
      out.push(parseArg(input.slice(start, i), line));
      start = i + 1;
    }
  }
  if (quote) fail(line, "Close the quoted string.");
  out.push(parseArg(input.slice(start), line));
  return out;
}
function calls(input, line) {
  const out = [];
  let pos = 0;
  while (pos < input.length) {
    const callStart = pos;
    const m = input.slice(pos).match(/^(\.?)([A-Za-z]+)\(/);
    if (!m) fail(line, "Expected a function call, such as .at(0).");
    if ((out.length === 0 && m[1]) || (out.length > 0 && !m[1]))
      fail(line, "Chain methods with a dot.");
    pos += m[0].length;
    const start = pos;
    let quoted = false,
      escaped = false;
    while (pos < input.length) {
      const c = input[pos];
      if (escaped) {
        escaped = false;
        pos++;
        continue;
      }
      if (c === "\\" && quoted) {
        escaped = true;
        pos++;
        continue;
      }
      if (c === '"') quoted = !quoted;
      if (c === ")" && !quoted) break;
      pos++;
    }
    if (pos === input.length)
      fail(line, "Close the function with a parenthesis.");
    out.push({
      name: m[2],
      args: splitArgs(input.slice(start, pos), line),
      start: callStart,
      end: pos + 1,
    });
    pos++;
  }
  return out;
}
export function compile(source) {
  if (typeof source !== "string" || source.length > 50000)
    fail(1, "Keep the composition under 50,000 characters.");
  const result = {
    name: "Untitled",
    duration: 12,
    params: Object.create(null),
    paramLines: Object.create(null),
    clips: [],
  };
  let hasComposition = false;
  const lines = source.split("\n");
  lines.forEach((raw, index) => {
    const line = index + 1;
    const input = raw.trim();
    if (!input || input.startsWith("//")) return;
    let parsed = calls(input, line);
    const root = parsed.shift();
    if (root.name === "composition") {
      if (hasComposition) fail(line, "Use one composition per score.");
      if (
        root.args.length !== 1 ||
        typeof root.args[0] !== "string" ||
        !root.args[0].trim()
      )
        fail(line, "Give the composition a name.");
      hasComposition = true;
      result.name = root.args[0];
      for (const call of parsed) {
        if (
          call.name !== "duration" ||
          call.args.length !== 1 ||
          typeof call.args[0] !== "number"
        )
          fail(line, "Composition supports .duration(seconds).");
        result.duration = call.args[0];
      }
      return;
    }
    if (root.name === "param") {
      if (
        parsed.length ||
        root.args.length !== 2 ||
        typeof root.args[0] !== "string" ||
        !/^[A-Za-z_][\w]*$/.test(root.args[0]) ||
        typeof root.args[1] === "object"
      )
        fail(line, 'Use param("name", "value") or param("name", 1).');
      if (Object.hasOwn(result.params, root.args[0]))
        fail(line, "Parameter names must be unique.");
      result.params[root.args[0]] = root.args[1];
      result.paramLines[root.args[0]] = index;
      return;
    }
    if (!["scene", "text", "shape"].includes(root.name))
      fail(line, `Unknown function: ${root.name}.`);
    if (
      root.args.length !== 1 ||
      typeof root.args[0] !== "string" ||
      !root.args[0].trim()
    )
      fail(line, "Give each clip a name.");
    if (result.clips.some((c) => c.id === root.args[0]))
      fail(line, "Clip names must be unique.");
    const clip = {
      id: root.args[0],
      type: root.name,
      line: index,
      at: 0,
      for: 12,
      value: "",
      place: "left",
      motion: "fade",
      look: "orbit",
      color: "#d6fa69",
      position: null,
      sourceAt: 0,
      sourceDuration: null,
      hasSourceWindow: false,
    };
    const allowed = {
      scene: ["at", "for", "look", "sourceAt", "sourceDuration"],
      text: [
        "at",
        "for",
        "value",
        "place",
        "motion",
        "position",
        "sourceAt",
        "sourceDuration",
      ],
      shape: [
        "at",
        "for",
        "color",
        "motion",
        "position",
        "sourceAt",
        "sourceDuration",
      ],
    };
    const seen = new Set();
    for (const call of parsed) {
      if (
        !allowed[root.name].includes(call.name) ||
        call.args.length !== (call.name === "position" ? 2 : 1) ||
        seen.has(call.name)
      )
        fail(line, `Unsupported or repeated method: .${call.name}().`);
      seen.add(call.name);
      clip[call.name] = call.name === "position" ? call.args : call.args[0];
      if (["sourceAt", "sourceDuration"].includes(call.name))
        clip.hasSourceWindow = true;
    }
    result.clips.push(clip);
  });
  if (!hasComposition) fail(1, 'Start with composition("Name").duration(12).');
  if (
    !Number.isFinite(result.duration) ||
    result.duration < 1 ||
    result.duration > 60
  )
    fail(1, "Duration must be between 1 and 60 seconds.");
  if (result.clips.length > 24)
    fail(1, "This prototype supports up to 24 clips.");
  const resolve = (value, line) => {
    if (value && typeof value === "object") {
      if (!Object.hasOwn(result.params, value.ref))
        fail(line, `Unknown parameter: $${value.ref}.`);
      return result.params[value.ref];
    }
    return value;
  };
  for (const clip of result.clips) {
    for (const key of [
      "at",
      "for",
      "value",
      "place",
      "motion",
      "look",
      "color",
      "sourceAt",
      "sourceDuration",
    ])
      clip[key] = resolve(clip[key], clip.line + 1);
    if (clip.position) {
      clip.position = clip.position.map((value) =>
        resolve(value, clip.line + 1),
      );
      if (
        !clip.position.every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
        )
      )
        fail(clip.line + 1, "Position needs two finite pixel coordinates.");
    }
    clip.sourceDuration ??= clip.sourceAt + clip.for;
    if (
      !Number.isFinite(clip.sourceAt) ||
      clip.sourceAt < 0 ||
      !Number.isFinite(clip.sourceDuration) ||
      clip.sourceDuration <= 0 ||
      clip.sourceDuration > 60 ||
      clip.sourceAt + clip.for > clip.sourceDuration + 0.000001
    )
      fail(clip.line + 1, "Clip exceeds its animation source window.");
    if (
      !Number.isFinite(clip.at) ||
      clip.at < 0 ||
      !Number.isFinite(clip.for) ||
      clip.for <= 0 ||
      clip.at + clip.for > result.duration + 0.001
    )
      fail(clip.line + 1, "Keep clip timing inside the composition.");
    if (typeof clip.value !== "string")
      fail(clip.line + 1, "Text values must be strings.");
    if (!["left", "center", "bottom"].includes(clip.place))
      fail(clip.line + 1, 'Place supports "left", "center", or "bottom".');
    if (!["rise", "fade", "orbit", "pulse", "none"].includes(clip.motion))
      fail(
        clip.line + 1,
        'Motion supports "rise", "fade", "orbit", "pulse", or "none".',
      );
    if (!["orbit", "pulse", "grid"].includes(clip.look))
      fail(clip.line + 1, 'Look supports "orbit", "pulse", or "grid".');
    if (typeof clip.color !== "string" || !/^#[0-9a-f]{6}$/i.test(clip.color))
      fail(clip.line + 1, 'Colors use six-digit hex, such as "#d6fa69".');
  }
  if (
    "tempo" in result.params &&
    (typeof result.params.tempo !== "number" ||
      result.params.tempo < 0.2 ||
      result.params.tempo > 3)
  )
    fail(result.paramLines.tempo + 1, "Tempo must be between 0.2 and 3.");
  return result;
}
export function replaceParam(source, name, value) {
  const model = compile(source);
  if (!Object.hasOwn(model.paramLines, name))
    throw new Error("Parameter not found.");
  const lines = source.split("\n");
  lines[model.paramLines[name]] =
    `param(${JSON.stringify(name)}, ${JSON.stringify(value)})`;
  return lines.join("\n");
}
export function replaceTiming(source, id, key, value) {
  if (!["at", "for"].includes(key)) throw new Error("Invalid timing field.");
  const model = compile(source),
    clip = model.clips.find((c) => c.id === id);
  if (!clip) throw new Error("Clip not found.");
  const lines = source.split("\n"),
    raw = lines[clip.line],
    indent = raw.length - raw.trimStart().length;
  const call = calls(raw.trim(), clip.line + 1).find((c) => c.name === key);
  const method = "." + key + "(" + Math.round(value * 100) / 100 + ")";
  lines[clip.line] = call
    ? raw.slice(0, indent + call.start) + method + raw.slice(indent + call.end)
    : raw + method;
  const next = lines.join("\n");
  compile(next);
  return next;
}
export function encodeTemplate(source) {
  compile(source);
  return encodeURIComponent(source);
}
export function decodeTemplate(hash) {
  const m = hash.match(/^#template=(.+)$/);
  if (!m) return null;
  const source = decodeURIComponent(m[1]);
  compile(source);
  return source;
}
export function visibleClips(model, time) {
  return model.clips.filter((c) => time >= c.at && time < c.at + c.for);
}

export { calls as parseStatement };
