import { describe, expect, test } from "bun:test";
import { betweenGaps, type Round, sessionMetrics, toolMix } from "./fit";

const round = (index: number, requestStart: boolean, t0: number, t1: number): Round => ({
    index,
    requestStart,
    t0,
    t1,
});

describe("sessionMetrics", () => {
    test("counts steps per request and the idle gap before each later request", () => {
        const m = sessionMetrics([
            round(0, true, 0, 1000),
            round(1, false, 2000, 3000),
            round(2, true, 10_000, 11_000),
            round(3, false, 12_000, 13_000),
            round(4, false, 14_000, 15_000),
        ]);
        expect(m.steps).toEqual([2, 3]);
        expect(m.idle).toEqual([7]);
        expect(m.end).toBe(15_000);
    });

    test("rounds before the first user message belong to no request", () => {
        const m = sessionMetrics([round(0, false, 0, 10), round(1, true, 20, 30)]);
        expect(m.steps).toEqual([1]);
        expect(m.idle).toEqual([0.01]);
    });

    test("an overlapping earlier round yields no gap; the gap runs from the latest end", () => {
        const m = sessionMetrics([
            round(0, true, 0, 9000),
            round(1, false, 1000, 2000),
            round(2, true, 5000, 6000),
            round(3, true, 12_000, 13_000),
        ]);
        expect(m.idle).toEqual([3]);
    });

    test("orders rounds by start time, then index", () => {
        const m = sessionMetrics([round(1, false, 0, 5), round(0, true, 0, 5)]);
        expect(m.steps).toEqual([2]);
    });

    test("a session with no user message has no steps and no idle gaps", () => {
        expect(sessionMetrics([round(0, false, 0, 1)])).toEqual({ steps: [], idle: [], end: 1 });
    });
});

test("betweenGaps keeps positive gaps between consecutive sessions only", () => {
    expect(
        betweenGaps([
            [10_000, 20_000],
            [0, 5000],
            [15_000, 30_000],
            [40_000, 41_000],
        ]),
    ).toEqual([5, 10]);
});

test("toolMix groups tools, counts only true errors, and lists no names for other", () => {
    const mix = toolMix(
        [
            { tool_name: "Bash", is_error: true },
            { tool_name: "Bash", is_error: null },
            { tool_name: "Read", is_error: false },
            { tool_name: "Mystery", is_error: true },
        ],
        "src",
    );
    expect(mix).toEqual({
        source: "src",
        n: 4,
        categories: [
            { category: "shell", share: 0.5, error_rate: 0.5, tools: ["Bash"] },
            { category: "other", share: 0.25, error_rate: 1, tools: [] },
            { category: "read", share: 0.25, error_rate: 0, tools: ["Read"] },
        ],
    });
});
