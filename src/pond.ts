// Water surface simulation: a damped wave height-field on a character grid. Pure math and
// typed arrays, no DOM, so it runs in a browser, a terminal renderer or a test.

// water surface: amplitude bucket -> glyph codepoint; color by intensity AND sign
// (crest = bright cyan, trough = deep blue) for clear wave color contrast.
export const WATER_CP = [0x20, 0xb7 /*·*/, 0x2d9 /*˙*/, 0x7e /*~*/, 0x2248 /*≈*/];
export const WATER_CREST_HEX = ["#0e2329", "#2f6b7a", "#52a0b6", "#86d6ec", "#cdf2ff"];
export const WATER_TROUGH_HEX = ["#0e2329", "#1d3c55", "#274f72", "#2c5f8c", "#356fa6"];
// deep green-black pond floor
export const POND_BG_HEX = "#030c0d";

// cursor splash tuning: a pointer move and a pointer press
export const MOVE_AMP = 2.2;
export const DOWN_AMP = 6;
export const SPLASH_CAP = 64;

// wave amplitude -> glyph bucket (0 = calm/space)
export function waterBucket(a: number): number {
  return a < 0.07 ? 0 : a > 0.6 ? 4 : a > 0.32 ? 3 : a > 0.16 ? 2 : 1;
}

// Wave-propagation hot loop. Plain JS: the JIT vectorises this tight typed-array loop.
// Writes the next field into `prev` from `cur`'s neighbours; caller swaps.
// Anisotropic: horizontal coupling 4x vertical (character cells are ~2:1 tall) so a
// ripple renders as a circle on screen instead of a vertical ellipse.
function waveStep(cur: Float32Array, prev: Float32Array, w: number, h: number, damp: number): void {
  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 1) {
      const i = row + x;
      prev[i] = (0.75 * cur[i] - prev[i] + 0.5 * (cur[i - 1] + cur[i + 1]) + 0.125 * (cur[i - w] + cur[i + w])) * damp;
    }
  }
}

// The water: `cols` x `rows` cells of wave height. Splashes queue and land on the next
// wave step; `disturb` lands at once (for callers that run inside a step).
export class Pond {
  readonly W: number;
  readonly H: number;
  // cursor cell, for scenes that react to the pointer; the water itself ignores it
  mouse: { x: number; y: number } | null = null;
  private splashes: { x: number; y: number; amp: number }[] = [];
  private hCur: Float32Array;
  private hPrev: Float32Array;
  private waveAcc = 0;

  constructor(cols: number, rows: number) {
    this.W = Math.max(10, cols);
    this.H = Math.max(6, rows);
    this.hCur = new Float32Array(this.W * this.H);
    this.hPrev = new Float32Array(this.W * this.H);
  }

  // wave heights, W×H cell space (post-swap current buffer)
  get field(): Float32Array {
    return this.hCur;
  }

  // queue a splash at cell coords; capped so a fast cursor can't stockpile energy
  splash(x: number, y: number, amp: number): void {
    if (this.splashes.length < SPLASH_CAP) this.splashes.push({ x, y, amp });
  }

  // push the surface down at a cell right now; edge cells are fixed
  disturb(x: number, y: number, amp: number): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= this.W - 1 || yi >= this.H - 1) return;
    this.hCur[yi * this.W + xi] -= amp;
  }

  // Advance the water on a fixed 30Hz clock: the stencil's wave speed and damping are
  // per-step, so stepping per frame would tie ripple physics to fps. `onTick` runs after
  // each wave step (queued splashes already landed), for wakes that follow the step clock.
  // deltaMs is clamped at 100ms so a resumed background tab does not explode the waves.
  step(deltaMs: number, onTick?: () => void): void {
    this.waveAcc += Math.min(deltaMs, 100);
    let steps = 0;
    while (this.waveAcc >= 33 && steps < 4) {
      this.waveAcc -= 33;
      steps += 1;
      const cur = this.hCur;
      const prev = this.hPrev;
      waveStep(cur, prev, this.W, this.H, 0.93);
      this.hCur = prev;
      this.hPrev = cur;
      const q = this.splashes;
      for (let i = 0; i < q.length; i += 1) this.disturb(q[i].x, q[i].y, q[i].amp);
      q.length = 0;
      onTick?.();
    }
    if (this.waveAcc >= 33) this.waveAcc = 0; // stalled — drop the backlog
  }
}
