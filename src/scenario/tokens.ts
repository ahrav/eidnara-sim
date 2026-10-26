import type { Rng } from "../rng";

// ADJ and NOUN match the v1 A/B harness word lists in eidnara
// packages/e2e-tests/src/ab-eval/world.ts.
const ADJ =
    "amber brisk cobalt dusky ember fallow gilded hollow ivory jaunty kelp lunar mossy nimble ochre pewter quiet russet sable tawny umber velvet wistful xeric yonder zephyr briny cinder drowsy fable".split(
        " ",
    );
const NOUN =
    "otter heron falcon marmot lynx badger egret ibis jackal kestrel lemur magpie newt oriole puffin quokka raven stoat tapir urchin vole walrus yak zebu bison condor dingo gecko hare koala".split(
        " ",
    );

const MAX_DRAWS = 100_000;

/** number(), codename(), and word() share a per-instance uniqueness guarantee. */
export class Tokens {
    private used = new Set<string>();
    constructor(private readonly rng: Rng) {}

    private fresh(make: () => string): string {
        for (let draw = 0; draw < MAX_DRAWS; draw++) {
            const value = make();
            if (!this.used.has(value)) {
                this.used.add(value);
                return value;
            }
        }
        throw new Error(
            `no unclaimed value after ${MAX_DRAWS} draws; the value space is too small`,
        );
    }

    number(): string {
        // Five digits up to 65535, so a figure a template states as a port is a valid one.
        return this.fresh(() => String(10000 + Math.floor(this.rng.next() * 55536)));
    }

    codename(): string {
        return this.fresh(
            () =>
                `${this.rng.pick(ADJ)}-${this.rng.pick(NOUN)}-${10 + Math.floor(this.rng.next() * 89)}`,
        );
    }

    word(): string {
        return this.fresh(() => `${this.rng.pick(ADJ)}_${this.rng.pick(NOUN)}`);
    }
}
