import { visibleClips } from "../core/engine.mjs";
export const WIDTH = 1920,
  HEIGHT = 1080;
const clamp = (value) => Math.max(0, Math.min(1, value));
const ease = (value) => 1 - (1 - clamp(value)) ** 3;
export function motionState(clip, time, tempo = 1) {
  const elapsed = time - clip.at + clip.sourceAt,
    remaining = clip.sourceDuration - elapsed;
  return {
    elapsed,
    phase: elapsed * tempo,
    progress: clip.motion === "none" ? 1 : ease(elapsed / 0.7),
    alpha:
      clip.motion === "none" ? 1 : ease(elapsed / 0.7) * clamp(remaining / 0.4),
  };
}
function wrap(ctx, value, width, font) {
  ctx.font = font;
  const lines = [];
  let line = "";
  for (const word of String(value).slice(0, 500).split(/\s+/)) {
    const next = line ? line + " " + word : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}
export function frameGeometry(ctx, model, time) {
  return visibleClips(model, time).map((clip) => {
    const motion = motionState(clip, time, Number(model.params.tempo) || 1);
    if (clip.type === "scene")
      return {
        clip,
        kind: "scene",
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: WIDTH,
        height: HEIGHT,
        alpha: 1,
      };
    if (clip.type === "shape") {
      const [x, y] = clip.position || [1380, 548],
        pulse =
          clip.motion === "pulse" ? 1 + Math.sin(motion.phase * 2.5) * 0.08 : 1;
      return {
        clip,
        kind: "shape",
        ...motion,
        x,
        y: y + (clip.motion === "rise" ? (1 - motion.progress) * 75 : 0),
        rotation: clip.motion === "orbit" ? -0.32 + motion.phase * 0.15 : -0.32,
        pulse,
        width: 750 * pulse,
        height: 750 * pulse,
      };
    }
    const bottom = clip.place === "bottom",
      center = clip.place === "center",
      size = bottom ? 32 : 138,
      font = (bottom ? "400 " : "800 ") + size + "px Arial, sans-serif";
    let [x, y] = clip.position || [
      center ? 960 : 95,
      bottom ? 864 : center ? 470 : 343,
    ];
    if (clip.motion === "rise") y += (1 - motion.progress) * 75;
    if (clip.motion === "orbit") {
      x += Math.sin(motion.phase) * 20;
      y += Math.cos(motion.phase) * 20;
    }
    const maxWidth = center ? 1550 : bottom ? 1700 : 820,
      lines = wrap(ctx, clip.value, maxWidth, font);
    const width = Math.max(
        24,
        ...lines.map((line) => Math.min(maxWidth, ctx.measureText(line).width)),
      ),
      height = Math.max(size, lines.length * size * 1.02);
    return {
      clip,
      kind: "text",
      ...motion,
      x,
      y,
      left: center ? x - width / 2 : x,
      top: y - size * 0.82,
      width,
      height,
      font,
      size,
      lines,
      maxWidth,
      align: center ? "center" : "left",
      alpha:
        motion.alpha *
        (clip.motion === "pulse"
          ? 0.7 + 0.3 * Math.sin(motion.phase * 3) ** 2
          : 1),
    };
  });
}
export function hitTest(items, x, y) {
  for (const item of [...items].reverse()) {
    if (item.alpha < 0.02) continue;
    if (item.kind === "shape") {
      const dx = x - item.x,
        dy = y - item.y,
        c = Math.cos(-item.rotation),
        s = Math.sin(-item.rotation);
      if (
        Math.abs(dx * c - dy * s) <= item.width / 2 &&
        Math.abs(dx * s + dy * c) <= item.height / 2
      )
        return item;
    } else if (
      x >= item.left &&
      x <= item.left + item.width &&
      y >= item.top &&
      y <= item.top + item.height
    )
      return item;
  }
  return null;
}
export function renderFrame(ctx, model, time, { selected = null } = {}) {
  const items = frameGeometry(ctx, model, time);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#171b18";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  let look = "orbit";
  for (const item of items) {
    const { clip } = item;
    ctx.save();
    ctx.globalAlpha = item.alpha;
    const light = look === "orbit",
      ink = light ? "#202822" : "#e7eadf";
    if (item.kind === "scene") {
      look = clip.look;
      ctx.fillStyle =
        look === "orbit" ? "#e9e7dc" : look === "pulse" ? "#2a1e29" : "#142137";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = look === "orbit" ? "#20282220" : "#b0c8b71c";
      ctx.lineWidth = 2;
      if (look === "grid") {
        for (let x = 0; x < WIDTH; x += 90) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, HEIGHT);
          ctx.stroke();
        }
        for (let y = 0; y < HEIGHT; y += 90) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(WIDTH, y);
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(80, 160);
        ctx.lineTo(1840, 160);
        ctx.moveTo(80, 942);
        ctx.lineTo(1840, 942);
        ctx.stroke();
      }
      ctx.fillStyle = look === "orbit" ? "#202822" : "#e7eadf";
      ctx.font = "23px monospace";
      ctx.fillText("FRAMECODE", 85, 107);
      ctx.textAlign = "right";
      ctx.fillText("A STUDY IN MOTION / 001", 1835, 107);
      ctx.font = "18px monospace";
      ctx.fillText("CODE → FORM → FEELING", 1835, 996);
      ctx.textAlign = "left";
      ctx.fillText(
        String(Math.floor(time * 30)).padStart(4, "0") +
          " / " +
          Math.round(model.duration * 30),
        85,
        996,
      );
    } else if (item.kind === "text") {
      ctx.fillStyle = ink;
      ctx.font = item.font;
      ctx.textAlign = item.align;
      item.lines.forEach((line, index) =>
        ctx.fillText(
          line,
          item.x,
          item.y + index * item.size * 1.02,
          item.maxWidth,
        ),
      );
    } else {
      const accent = clip.color;
      ctx.translate(item.x, item.y);
      ctx.rotate(item.rotation);
      ctx.scale(item.pulse, item.pulse);
      if (look === "grid") {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 11;
        for (let i = 0; i < 6; i++) {
          ctx.save();
          ctx.rotate(
            i * 0.23 + (clip.motion === "orbit" ? item.phase * 0.1 : 0),
          );
          ctx.strokeRect(
            -210 - i * 18,
            -210 - i * 18,
            420 + i * 36,
            420 + i * 36,
          );
          ctx.restore();
        }
      } else {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 70;
        ctx.beginPath();
        ctx.arc(0, 0, 300, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = light ? "#1b2922" : accent;
        ctx.lineWidth = 3;
        for (let i = 0; i < 10; i++) {
          ctx.beginPath();
          ctx.ellipse(
            0,
            0,
            90 + i * 23,
            260 + i * 10,
            Math.PI * 0.22,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
        const p = clip.motion === "orbit" ? item.phase * 0.85 : 1;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(Math.cos(p) * 305, Math.sin(p) * 305, 51, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  const active = items.find((item) => item.clip.id === selected);
  if (active) {
    ctx.save();
    ctx.strokeStyle = "#78a52c";
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 8]);
    let left = active.left,
      top = active.top;
    if (active.kind === "shape") {
      left = active.x - active.width / 2;
      top = active.y - active.height / 2;
    }
    ctx.strokeRect(left + 2, top + 2, active.width - 4, active.height - 4);
    ctx.restore();
  }
  return items;
}
