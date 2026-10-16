import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { cacheDistortion } from "./preflight";

test("the cache distortion names the toolchain paths the sandbox keeps read-only", () => {
    const base = loadConfig();
    const kept = cacheDistortion({ ...base, toolchain: { ...base.toolchain, keep: ["/a", "/b"] } });
    expect(kept).toContain("/a, /b");
    const none = cacheDistortion({ ...base, toolchain: { ...base.toolchain, keep: [] } });
    expect(none).toContain("no toolchain path is kept read-only");
});
