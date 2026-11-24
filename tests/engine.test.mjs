import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compile,
  DEFAULT_SOURCE,
  TEMPLATES,
  replaceParam,
  replaceTiming,
  encodeTemplate,
  decodeTemplate,
  visibleClips,
} from "../src/core/engine.mjs";
test("example and every reusable template compile into timed clips", () => {
  for (const t of TEMPLATES) {
    const m = compile(t.source);
    assert.equal(m.clips.length, 4);
    assert.equal(m.duration, 12);
    assert.equal(m.clips[1].value, m.params.title);
  }
});
test("parameter edits resolve in rendered text without changing timing", () => {
  const m = compile(replaceParam(DEFAULT_SOURCE, "title", "SWARTZ IN MOTION"));
  assert.equal(m.clips[1].value, "SWARTZ IN MOTION");
  assert.equal(m.clips[1].at, 0.4);
});
test("timeline timing edits round trip through source", () => {
  const s = replaceTiming(DEFAULT_SOURCE, "Headline", "at", 0.8);
  assert.match(s, /\.at\(0.8\)/);
  assert.equal(compile(s).clips[1].at, 0.8);
  assert.throws(() => replaceTiming(s, "Headline", "at", 9), /inside/);
});
test("invalid and executable code is rejected with a line number", () => {
  for (const code of [
    DEFAULT_SOURCE + '\nalert("x")',
    DEFAULT_SOURCE.replace("$title", "$missing"),
    DEFAULT_SOURCE.replace(".at(0.4)", ".at(-1)"),
    DEFAULT_SOURCE.replace('"#d6fa69"', '"red"'),
  ]) {
    assert.throws(
      () => compile(code),
      (e) => Number.isInteger(e.line),
    );
  }
});
test("shared snapshot preserves unicode and remains independently editable", () => {
  const source = replaceParam(DEFAULT_SOURCE, "title", "夜 · MOVE 🚀");
  const s = decodeTemplate("#template=" + encodeTemplate(source));
  assert.equal(s, source);
  assert.equal(
    compile(replaceParam(s, "title", "REMIX")).params.title,
    "REMIX",
  );
  assert.equal(compile(source).params.title, "夜 · MOVE 🚀");
});
test("scrubbing observes clip start and exclusive end", () => {
  const m = compile(DEFAULT_SOURCE);
  assert.equal(visibleClips(m, 0).length, 2);
  assert.equal(visibleClips(m, 1).length, 4);
  assert.equal(visibleClips(m, 12).length, 0);
});
test("timing edits preserve method-like text inside clip names and values", () => {
  const source = DEFAULT_SOURCE.replace('"Headline"', '"A.at(9)"').replace(
    ".value($title)",
    '.value("Keep .at(9) intact")',
  );
  const result = compile(replaceTiming(source, "A.at(9)", "at", 0.8));
  assert.equal(result.clips[1].id, "A.at(9)");
  assert.equal(result.clips[1].value, "Keep .at(9) intact");
  assert.equal(result.clips[1].at, 0.8);
});
test("parameter names must be referenceable identifiers", () => {
  assert.throws(() => compile(DEFAULT_SOURCE + '\nparam("123", 1)'), /param/);
});
test("parameter dictionaries safely preserve names shared with Object.prototype", () => {
  const source =
    DEFAULT_SOURCE +
    '\nparam("__proto__", "hello")\ntext("Extra").at(0).for(1).value($__proto__)';
  assert.equal(compile(source).clips.at(-1).value, "hello");
  assert.equal(
    compile(replaceParam(source, "__proto__", "remixed")).params.__proto__,
    "remixed",
  );
});
test("image clips compile with required properties", () => {
  const source = `composition("Test").duration(5)
image("Test Image").at(1).for(2).source("test.jpg")`;
  const m = compile(source);
  assert.equal(m.clips.length, 1);
  assert.equal(m.clips[0].type, "image");
  assert.equal(m.clips[0].source, "test.jpg");
  assert.equal(m.clips[0].fit, "contain");
  assert.equal(m.clips[0].at, 1);
  assert.equal(m.clips[0].for, 2);
});
test("image clips support different fit modes", () => {
  const sources = [
    'image("Test").at(0).for(1).source("test.jpg").fit("contain")',
    'image("Test").at(0).for(1).source("test.jpg").fit("cover")',
    'image("Test").at(0).for(1).source("test.jpg").fit("fill")',
  ];
  for (const source of sources) {
    const m = compile(`composition("Test").duration(1)\n${source}`);
    assert.equal(m.clips[0].type, "image");
    assert.equal(m.clips[0].fit, source.match(/fit\("([^"]+)"\)/)[1]);
  }
});
test("image clips reject invalid fit modes", () => {
  assert.throws(
    () => compile('composition("Test").duration(12)\nimage("Test").source("test.jpg").fit("invalid")'),
    /Fit supports "contain", "cover", or "fill"\./
  );
});
test("image clips require source path", () => {
  assert.throws(
    () => compile('composition("Test").duration(12)\nimage("Test")'),
    /Image clips require a source path\./
  );
  assert.throws(
    () => compile('composition("Test").duration(12)\nimage("Test").source("")'),
    /Image clips require a source path\./
  );
});
test("image clips support position parameter", () => {
  const source = `composition("Test").duration(5)
image("Test Image").at(1).for(2).source("test.jpg").position(100, 200)`;
  const m = compile(source);
  assert.equal(m.clips[0].type, "image");
  assert.deepEqual(m.clips[0].position, [100, 200]);
});

test("video clips carry a media source window and default fit", () => {
  const m = compile(
    'composition("Media").duration(10)\nvideo("B-roll").at(1).for(4).source("C:/clips/a.mp4").sourceDuration(30)',
  );
  const clip = m.clips[0];
  assert.equal(clip.type, "video");
  assert.equal(clip.source, "C:/clips/a.mp4");
  assert.equal(clip.fit, "contain");
  assert.equal(clip.sourceAt, 0);
  assert.equal(clip.sourceDuration, 30);
  assert.equal(clip.hasSourceWindow, true, "media always has a source window");
  assert.equal(clip.gain, 1);
});

test("media clips may declare up to one hour of source while images stay capped at 60", () => {
  const video = compile(
    'composition("Media").duration(10)\nvideo("Long").at(0).for(10).source("C:/a.mp4").sourceDuration(3600)',
  );
  assert.equal(video.clips[0].sourceDuration, 3600);
  assert.throws(
    () =>
      compile(
        'composition("Media").duration(10)\nvideo("Long").at(0).for(10).source("C:/a.mp4").sourceDuration(3600.5)',
      ),
    /Clip exceeds its animation source window\./,
  );
  assert.throws(
    () =>
      compile(
        'composition("Images").duration(10)\nimage("Still").at(0).for(10).source("a.png").sourceDuration(61)',
      ),
    /Clip exceeds its animation source window\./,
  );
});

test("audio clips support gain and reject visual-only properties", () => {
  const m = compile(
    'composition("Sound").duration(10)\naudio("Score").at(0).for(10).source("C:/audio/score.mp3").gain(0.4)',
  );
  const clip = m.clips[0];
  assert.equal(clip.type, "audio");
  assert.equal(clip.gain, 0.4);
  assert.equal(clip.hasSourceWindow, true);
  assert.equal(clip.opacity, 1, "audio keeps the inert default but cannot set it");
  for (const method of ['scale(2)', 'rotation(15)', 'position(1, 2)', 'opacity(0.5)', 'fit("cover")']) {
    assert.throws(
      () =>
        compile(
          `composition("Sound").duration(10)\naudio("Score").at(0).for(10).source("C:/audio/score.mp3").${method}`,
        ),
      /Unsupported or repeated method/,
      method,
    );
  }
  assert.throws(
    () => compile('composition("Sound").duration(10)\nvideo("V").at(0).for(5).source("a.mp4").gain(1)'),
    /Unsupported or repeated method/,
  );
});

test("media clips require a source and validate gain like fit", () => {
  assert.throws(
    () => compile('composition("Media").duration(10)\nvideo("V").at(0).for(5)'),
    /Video clips require a source path\./,
  );
  assert.throws(
    () => compile('composition("Media").duration(10)\naudio("A").at(0).for(5)'),
    /Audio clips require a source path\./,
  );
  assert.throws(
    () => compile('composition("Media").duration(10)\nvideo("V").at(0).for(5).source("a.mp4").fit("stretch")'),
    /Fit supports "contain", "cover", or "fill"\./,
  );
  for (const gain of [-0.1, 2.1, '"loud"']) {
    assert.throws(
      () =>
        compile(
          `composition("Sound").duration(10)\naudio("A").at(0).for(5).source("a.mp3").gain(${gain})`,
        ),
      /Gain must be between 0 and 2\./,
    );
  }
});

test("media clips use sourceAt as the trim offset without moving on end trim", () => {
  const m = compile(
    'composition("Media").duration(20)\nvideo("V").at(2).for(5).source("a.mp4").sourceAt(10).sourceDuration(30)',
  );
  const clip = m.clips[0];
  assert.equal(clip.sourceAt, 10);
  assert.equal(clip.sourceDuration, 30);
  assert.equal(clip.hasSourceWindow, true);
});
