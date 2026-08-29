// =============================================================================
// Deterministic seeded RNG
// =============================================================================
// `Math.random()` is never used anywhere in R2S — it is not seedable, so it
// cannot produce reproducible datasets. Everything routes through this
// module instead. Algorithm: mulberry32 (small, fast, well-distributed,
// public domain), seeded by a 32-bit integer derived from the run's
// string/numeric seed via a simple string hash (xfnv1a).
// =============================================================================

export type RngState = { s: number };

/** 32-bit FNV-1a style string hash, used to turn arbitrary seed strings into
 * a numeric seed for mulberry32. Deterministic and dependency-free. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: string | number): Rng {
  const numericSeed = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return new Rng(numericSeed);
}

/**
 * Seeded pseudo-random number generator (mulberry32).
 * Deterministic: the same seed always produces the same sequence of calls.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new Error("int(): max must be >= min");
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** true with probability p (0..1). */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Pick a uniformly random element from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick(): array is empty");
    const item = arr[this.int(0, arr.length - 1)];
    if (item === undefined) throw new Error("pick(): unreachable");
    return item;
  }

  /** Weighted pick: `weights` must be the same length as `items`, all >= 0,
   * and sum to > 0. */
  weightedPick<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length !== weights.length) {
      throw new Error("weightedPick(): items and weights length mismatch");
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) throw new Error("weightedPick(): weights must sum to > 0");
    let target = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      target -= weights[i] ?? 0;
      if (target <= 0) {
        const item = items[i];
        if (item === undefined) throw new Error("weightedPick(): unreachable");
        return item;
      }
    }
    const last = items[items.length - 1];
    if (last === undefined) throw new Error("weightedPick(): unreachable");
    return last;
  }

  /** Approximately-Gaussian sample via sum of uniforms (Irwin-Hall / CLT
   * approximation) — good enough for synthetic data, fully deterministic. */
  gaussian(mean: number, stdDev: number): number {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += this.next();
    const standard = (sum - 3) / 1.5; // approx N(0,1)
    return mean + standard * stdDev;
  }
}
