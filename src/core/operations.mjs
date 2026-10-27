import { compile, parseStatement } from "./engine.mjs";

export const MIN_CLIP = 0.1;
const rounded = (value) => Math.round(value * 1000) / 1000;
const argument = (value) =>
  value && typeof value === "object" ? "$" + value.ref : JSON.stringify(value);
const statement = (calls) =>
  calls
    .map(
      (call, index) =>
        (index ? "." : "") +
        call.name +
        "(" +
        call.args.map(argument).join(", ") +
        ")",
    )
    .join("");

function getClip(source, id) {
  const model = compile(source),
    clip = model.clips.find((item) => item.id === id);
  if (!clip) throw new Error("Select a clip first.");
  return { model, clip };
}
function uniqueName(existing, base) {
  let name = base,
    index = 2;
  while (existing.includes(name)) name = base + " " + index++;
  return name;
}
function changedLine(raw, properties) {
  const indent = raw.slice(0, raw.length - raw.trimStart().length),
    calls = parseStatement(raw.trim(), 1);
  for (const [name, value] of Object.entries(properties)) {
    if (!["at", "for", "position", "sourceAt", "sourceDuration"].includes(name))
      throw new Error("Unsupported clip property.");
    const args = name === "position" ? value : [value];
    if (
      !Array.isArray(args) ||
      args.length !== (name === "position" ? 2 : 1) ||
      !args.every(Number.isFinite)
    )
      throw new Error("Use finite numeric values.");
    const next = { name, args: args.map(rounded) },
      index = calls.findIndex((call) => call.name === name);
    if (index < 0) calls.push(next);
    else calls[index] = next;
  }
  return indent + statement(calls);
}
export function updateClip(source, id, properties) {
  const { clip } = getClip(source, id),
    lines = source.split("\n");
  lines[clip.line] = changedLine(lines[clip.line], properties);
  const next = lines.join("\n");
  compile(next);
  return next;
}
export function timingBounds(clip, duration) {
  return {
    startMin: clip.hasSourceWindow ? Math.max(0, clip.at - clip.sourceAt) : 0,
    startMax: rounded(clip.at + clip.for - MIN_CLIP),
    endMin: rounded(clip.at + MIN_CLIP),
    endMax: clip.hasSourceWindow
      ? Math.min(duration, clip.at + clip.sourceDuration - clip.sourceAt)
      : duration,
  };
}
export function resizeClip(source, id, edge, time) {
  const { model, clip } = getClip(source, id),
    bounds = timingBounds(clip, model.duration);
  if (!Number.isFinite(time)) throw new Error("Use a valid time in seconds.");
  time = rounded(time);
  let changes;
  if (edge === "start") {
    if (time < bounds.startMin - 0.000001 || time > bounds.startMax + 0.000001)
      throw new Error("Start is outside the clip boundaries.");
    changes = { at: time, for: rounded(clip.at + clip.for - time) };
    if (clip.hasSourceWindow)
      changes.sourceAt = rounded(clip.sourceAt + time - clip.at);
  } else if (edge === "end") {
    if (time < bounds.endMin - 0.000001 || time > bounds.endMax + 0.000001)
      throw new Error("End is outside the clip boundaries.");
    changes = { for: rounded(time - clip.at) };
  } else throw new Error("Unknown resize edge.");
  return updateClip(source, id, changes);
}
export function splitClip(source, id, time) {
  const { model, clip } = getClip(source, id),
    left = rounded(time - clip.at),
    right = rounded(clip.for - left);
  if (!Number.isFinite(time) || left < MIN_CLIP || right < MIN_CLIP)
    throw new Error(
      "Place the playhead inside the clip, at least 0.1s from either edge.",
    );
  const lines = source.split("\n"),
    raw = lines[clip.line],
    newId = uniqueName(
      model.clips.map((c) => c.id),
      id,
    );
  const first = changedLine(raw, {
    for: left,
    sourceAt: clip.sourceAt,
    sourceDuration: clip.sourceDuration,
  });
  const parsed = parseStatement(
    changedLine(raw, {
      at: rounded(time),
      for: right,
      sourceAt: rounded(clip.sourceAt + left),
      sourceDuration: clip.sourceDuration,
    }).trim(),
    clip.line + 1,
  );
  parsed[0].args = [newId];
  lines.splice(clip.line, 1, first, statement(parsed));
  const next = lines.join("\n");
  compile(next);
  return { source: next, id: newId };
}
export function duplicateClip(source, id) {
  const { model, clip } = getClip(source, id),
    lines = source.split("\n"),
    calls = parseStatement(lines[clip.line].trim(), clip.line + 1);
  const newId = uniqueName(
    model.clips.map((c) => c.id),
    id,
  );
  calls[0].args = [newId];
  lines.splice(clip.line + 1, 0, statement(calls));
  const next = lines.join("\n");
  compile(next);
  return { source: next, id: newId };
}
export function deleteClip(source, id) {
  const { clip } = getClip(source, id),
    lines = source.split("\n");
  lines.splice(clip.line, 1);
  const next = lines.join("\n");
  compile(next);
  return next;
}
export function copyClip(source, id) {
  const { model, clip } = getClip(source, id);
  return JSON.stringify({
    format: "framecode-clip",
    version: 1,
    statement: source.split("\n")[clip.line].trim(),
    params: model.params,
  });
}
export function pasteClip(source, payload, time) {
  const model = compile(source);
  if (typeof payload !== "string" || payload.length > 1000000)
    throw new Error("The clipboard does not contain a Framecode clip.");
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new Error("The clipboard does not contain a Framecode clip.");
  }
  if (
    data?.format !== "framecode-clip" ||
    data.version !== 1 ||
    typeof data.statement !== "string" ||
    /[\r\n]/.test(data.statement) ||
    !data.params ||
    typeof data.params !== "object" ||
    Array.isArray(data.params)
  )
    throw new Error("Unsupported Framecode clipboard data.");
  const definitions = [];
  for (const [name, value] of Object.entries(data.params)) {
    if (
      !/^[A-Za-z_]\w*$/.test(name) ||
      !["string", "number"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("Invalid clipboard parameters.");
    definitions.push(
      "param(" + JSON.stringify(name) + ", " + JSON.stringify(value) + ")",
    );
  }
  const copied = compile(
    'composition("Clipboard").duration(60)\n' +
      definitions.join("\n") +
      "\n" +
      data.statement,
  );
  if (copied.clips.length !== 1) throw new Error("Copy one clip at a time.");
  const clip = copied.clips[0];
  if (clip.for > model.duration)
    throw new Error("This clip is longer than the composition.");
  const calls = parseStatement(data.statement, 1),
    imports = [],
    known = Object.assign(Object.create(null), model.params),
    renames = new Map();
  const refs = new Set(
    calls
      .flatMap((c) => c.args)
      .filter((arg) => arg && typeof arg === "object")
      .map((arg) => arg.ref),
  );
  for (const name of refs) {
    const value = data.params[name];
    let target = name;
    if (Object.hasOwn(known, name) && known[name] !== value)
      target = uniqueName(Object.keys(known), name).replaceAll(" ", "_");
    while (Object.hasOwn(known, target) && known[target] !== value)
      target += "_2";
    if (!Object.hasOwn(known, target)) {
      known[target] = value;
      imports.push(
        "param(" + JSON.stringify(target) + ", " + JSON.stringify(value) + ")",
      );
    }
    renames.set(name, target);
  }
  for (const call of calls)
    for (const arg of call.args)
      if (arg && typeof arg === "object")
        arg.ref = renames.get(arg.ref) || arg.ref;
  const id = uniqueName(
    model.clips.map((c) => c.id),
    clip.id,
  );
  calls[0].args = [id];
  const at = Number.isFinite(time)
    ? rounded(Math.max(0, Math.min(model.duration - clip.for, time)))
    : 0;
  const next =
    source +
    "\n" +
    [...imports, changedLine(statement(calls), { at })].join("\n");
  compile(next);
  return { source: next, id };
}
