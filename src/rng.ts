/** Seeded xoshiro128** generator; one seed yields one fixed draw sequence. */
export class Rng {
    private s: Uint32Array;

    constructor(seed: number) {
        // splitmix32 expands one 32-bit seed into four well-mixed state words.
        this.s = new Uint32Array(4);
        let x = seed >>> 0;
        for (let i = 0; i < 4; i++) {
            x = (x + 0x9e3779b9) >>> 0;
            let z = x;
            z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
            z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
            this.s[i] = (z ^ (z >>> 16)) >>> 0;
        }
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

    /** next() returns a uniform value in [0, 1) with 32 bits of resolution. */
    next(): number {
        return this.nextU32() / 4294967296;
    }

    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)] as T;
    }
}

function rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}
