/** 32-bit string hash: FNV-1a with a murmur finaliser; `salt` gives independent variants. */
function mix(text: string, salt: number): number {
  let h = (0x811c9dc5 ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hash32(text: string): number {
  return mix(text, 0);
}

/** Mixes a record's base hash with a revision step: integer maths only, so 500 steps cost microseconds. */
export function stepHash(base: number, step: number): number {
  let h = Math.imul(base ^ Math.imul(step + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** sfc32 seeded from a 128-bit hash of the key. The same key gives the same stream, anywhere. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(key: string) {
    this.a = mix(key, 1);
    this.b = mix(key, 2);
    this.c = mix(key, 3);
    this.d = mix(key, 4);
    for (let i = 0; i < 12; i++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) + t;
    return t >>> 0;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor((this.u32() / 4294967296) * n);
  }

  /** Integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)] as T;
  }

  /** True `percent` times in 100. */
  chance(percent: number): boolean {
    return this.int(100) < percent;
  }

  /** `#` becomes a digit and `?` an upper-case letter. */
  pattern(p: string): string {
    return p.replace(/[#?]/g, (ch) =>
      ch === '#' ? String(this.int(10)) : String.fromCharCode(65 + this.int(26)),
    );
  }

  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}
