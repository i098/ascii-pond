// Canvas renderer: draws a scene (the water, or water plus whatever swims in it) as
// monospace glyphs on a canvas, sized to its box, driven by the pointer.
import { DOWN_AMP, MOVE_AMP, POND_BG_HEX, Pond, WATER_CP, WATER_CREST_HEX, WATER_TROUGH_HEX, waterBucket } from "./pond.js";

// one glyph and its CSS color; scenes return shared instances, so a frame allocates nothing
export type Glyph = { readonly ch: string; readonly color: string };

// Anything the renderer can draw: a wave field plus an optional layer over it.
export interface Scene {
  readonly W: number;
  readonly H: number;
  readonly field: Float32Array;
  mouse?: { x: number; y: number } | null;
  splash(x: number, y: number, amp: number): void;
  step(deltaMs: number): void;
  // the glyph a cell shows above the water, or null for open water
  cell?(x: number, y: number): Glyph | null;
}

export interface MountOptions {
  // glyph size in CSS px (default 14)
  fontSize?: number;
  // row height as a multiple of fontSize (default 1.2)
  lineHeight?: number;
  fontFamily?: string;
  // canvas fill behind the glyphs (default the pond floor, "#030c0d"); "transparent" clears
  background?: string;
  // pointer input: splashes, and swimmers steer away from the pointer (default true)
  interactive?: boolean;
  // draw the waves; off by default, so the surface stays clear (default false)
  ripples?: boolean;
  // draw one still frame and never animate (default: the prefers-reduced-motion setting)
  reducedMotion?: boolean;
  // builds the scene for a grid; called again on every resize (default: plain water)
  scene?: (cols: number, rows: number) => Scene;
}

export interface PondHandle {
  destroy(): void;
}

const CREST: Glyph[] = WATER_CP.map((cp, b) => ({ ch: String.fromCharCode(cp), color: WATER_CREST_HEX[b] }));
const TROUGH: Glyph[] = WATER_CP.map((cp, b) => ({ ch: String.fromCharCode(cp), color: WATER_TROUGH_HEX[b] }));
const STILL_MS = 6000; // a reduced-motion still shows the scene this far in (koi have swum in)

// Mount on a <canvas>, or on any element (a canvas is added that fills it). The grid follows
// the box size; drawing pauses while the canvas is off-screen or the tab is hidden.
export function mountPond(target: HTMLElement, options: MountOptions = {}): PondHandle {
  const fontSize = options.fontSize ?? 14;
  const lineH = fontSize * (options.lineHeight ?? 1.2);
  const font = `${fontSize}px ${options.fontFamily ?? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"}`;
  const background = options.background ?? POND_BG_HEX;
  const makeScene = options.scene ?? ((cols: number, rows: number) => new Pond(cols, rows));
  const reduced = options.reducedMotion ?? window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const ripples = options.ripples ?? false;

  const own = !(target instanceof HTMLCanvasElement);
  const canvas = own ? document.createElement("canvas") : (target as HTMLCanvasElement);
  if (own) {
    canvas.style.cssText = "display:block;width:100%;height:100%;";
    target.appendChild(canvas);
  }
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

  let cellW = fontSize * 0.6;
  let scene: Scene = makeScene(1, 1);
  let cols = 0;
  let rows = 0;

  function resize() {
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font;
    ctx.textBaseline = "middle";
    cellW = ctx.measureText("M").width || fontSize * 0.6;
    const c = Math.floor(box.width / cellW);
    const r = Math.floor(box.height / lineH);
    // a new grid resets the scene, so anything swimming re-enters from the edges
    if (c !== cols || r !== rows) {
      cols = c;
      rows = r;
      scene = makeScene(cols, rows);
      if (reduced) for (let t = 0; t < STILL_MS; t += 33) scene.step(33);
    }
    draw();
  }

  function draw() {
    if (background === "transparent") ctx.clearRect(0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const { W, field } = scene;
    const w = Math.min(cols, W);
    const h = Math.min(rows, scene.H);
    for (let y = 0; y < h; y += 1) {
      const py = (y + 0.5) * lineH;
      for (let x = 0; x < w; x += 1) {
        let g = scene.cell?.(x, y) ?? null;
        if (!g && ripples) {
          const v = field[y * W + x];
          const b = waterBucket(v < 0 ? -v : v);
          if (b === 0) continue;
          g = (v > 0 ? CREST : TROUGH)[b];
        }
        if (!g) continue;
        ctx.fillStyle = g.color;
        ctx.fillText(g.ch, x * cellW, py);
      }
    }
  }

  // pointer → ripples, gated on cell change so the splash rate stays sane
  let lastX = -1;
  let lastY = -1;
  let moveN = 0;
  const cellOf = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / cellW), y: Math.floor((e.clientY - r.top) / lineH) };
  };
  const onMove = (e: PointerEvent) => {
    const c = cellOf(e);
    scene.mouse = c;
    if (c.x === lastX && c.y === lastY) return;
    lastX = c.x;
    lastY = c.y;
    if (moveN++ % 2 === 0) scene.splash(c.x, c.y, MOVE_AMP);
  };
  const onDown = (e: PointerEvent) => {
    const c = cellOf(e);
    scene.splash(c.x, c.y, DOWN_AMP);
  };
  const onLeave = () => {
    scene.mouse = null;
  };
  const interactive = !reduced && options.interactive !== false;
  if (interactive) {
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerdown", onDown);
    target.addEventListener("pointerleave", onLeave);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // rAF already stops in hidden tabs; the observer also stops it while scrolled away
  let raf = 0;
  let last = 0;
  function frame(now: number) {
    scene.step(last ? now - last : 0);
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  }
  const io = new IntersectionObserver(([entry]) => {
    cancelAnimationFrame(raf);
    last = 0;
    if (entry.isIntersecting && !reduced) raf = requestAnimationFrame(frame);
  });
  io.observe(canvas);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      if (interactive) {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerdown", onDown);
        target.removeEventListener("pointerleave", onLeave);
      }
      if (own) canvas.remove();
    },
  };
}
