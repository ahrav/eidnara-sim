import type { Rng } from "../rng";
import { sample } from "./cdf";
import { type Distributions, table } from "./distributions";

export interface SampledSession {
    requests: number;
    idle_s: number[];
    steps: number[];
    append_tokens: number[];
}

export function sampleSession(dist: Distributions, rng: Rng, tailFloor = 0): SampledSession {
    const [idle, steps, append] = [
        table(dist, "idle_within_session_s"),
        table(dist, "tool_steps_per_request"),
        table(dist, "append_tokens_per_step"),
    ];
    const requests = sample(table(dist, "requests_per_session"), rng, tailFloor);
    const session: SampledSession = { requests, idle_s: [], steps: [], append_tokens: [] };
    for (let r = 0; r < requests; r++) {
        if (r > 0) session.idle_s.push(sample(idle, rng));
        const n = Math.max(1, sample(steps, rng));
        session.steps.push(n);
        for (let s = 0; s < n; s++) {
            session.append_tokens.push(sample(append, rng));
        }
    }
    return session;
}
