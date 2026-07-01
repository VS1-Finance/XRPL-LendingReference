import { createHash } from "node:crypto";

// A small, deterministic pseudo-random generator. The same seed always produces the same sequence,
// which is what makes a bot run reproducible: same seed plus the same starting ledger state yields
// the same sequence of decisions. This is a plain generator, not a cryptographic one — determinism
// and reproducibility are the goals, not unpredictability.
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    // Derive a 32-bit state from the seed string so any string seed is usable.
    const digest = createHash("sha256").update(seed).digest();
    this.state = digest.readUInt32LE(0);
  }

  // Next float in [0, 1). mulberry32.
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Next integer in [min, max].
  nextInt(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  // True with the given probability (0..1).
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  // Pick one item from a list of weighted choices. Weights need not sum to one; a non-positive total
  // falls back to the first choice.
  weighted<T>(choices: { value: T; weight: number }[]): T {
    if (choices.length === 0) throw new Error("weighted() needs at least one choice");
    const total = choices.reduce((sum, c) => sum + Math.max(0, c.weight), 0);
    if (total <= 0) return choices[0]!.value;
    let roll = this.next() * total;
    for (const c of choices) {
      roll -= Math.max(0, c.weight);
      if (roll < 0) return c.value;
    }
    return choices[choices.length - 1]!.value;
  }
}

// A derived generator for a named stream, so independent concerns (variant assignment, per-variant
// timing) draw from separate reproducible sequences off the same root seed.
export function seededStream(rootSeed: string, stream: string): SeededRandom {
  return new SeededRandom(`${rootSeed}\0${stream}`);
}
