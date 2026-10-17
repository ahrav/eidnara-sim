/**
 * Seeded xoshiro128** generator; one seed yields one fixed draw sequence.
 * A splitmix32 chain over the low 32 bits fills the state; a nonzero high
 * half continues the same chain for four more rounds, which makes the two
 * halves' contributions order-dependent.
 */
export class Rng {
    private s: Uint32Array;

    constructor(seed: number) {
        if (!Number.isSafeInteger(seed) || seed < 0) {
            throw new Error(`Rng: seed ${seed} is not a non-negative safe integer`);
        }
        this.s = new Uint32Array(4);
        const high = Math.floor(seed / 4294967296);
        let x = seed % 4294967296;
        for (let i = 0; i < 4; i++) {
            x = (x + 0x9e3779b9) >>> 0;
            this.s[i] = mix32(x);
        }
        if (high > 0) {
            x = (x ^ high) >>> 0;
            for (let i = 0; i < 4; i++) {
                x = (x + 0x9e3779b9) >>> 0;
                this.s[i] = ((this.s[i] ?? 0) ^ mix32(x)) >>> 0;
            }
        }
        if (this.s.every((w) => w === 0)) this.s[0] = 1;
    }

    nextU32(): number {
        const s = this.s;
        const s0 = s[0] ?? 0;
        const s1 = s[1] ?? 0;
        const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
        const t = (s1 << 9) >>> 0;
        s[2] = (s[2] ?? 0) ^ s0;
        s[3] = (s[3] ?? 0) ^ s1;
        s[1] = s1 ^ (s[2] ?? 0);
        s[0] = s0 ^ (s[3] ?? 0);
        s[2] = (s[2] ?? 0) ^ t;
        s[3] = rotl(s[3] ?? 0, 11);
        return result;
    }

    /** The generator's state, for returning it to this point with `restore`. */
    state(): Uint32Array {
        return Uint32Array.from(this.s);
    }

    restore(state: Uint32Array): void {
        this.s = Uint32Array.from(state);
    }

    /** next() returns a uniform value in [0, 1) with 32 bits of resolution. */
    next(): number {
        return this.nextU32() / 4294967296;
    }

    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)] as T;
    }
}

function mix32(x: number): number {
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
}

function rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}
