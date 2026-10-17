import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { type HostContext, OpencodeSimHost, PiSimHost } from "./arms";

const ctx = (): HostContext => ({
    ...({} as HostContext),
    config: loadConfig(),
    root: "/x",
    launcher: "/x/sandbox.sh",
});

class StubbornPi extends PiSimHost {
    protected override async stopTree(): Promise<void> {
        throw new Error("host tree 4242 survived SIGKILL");
    }
}
class StubbornOc extends OpencodeSimHost {
    protected override async stopTree(): Promise<void> {
        throw new Error("host tree 4242 survived SIGKILL");
    }
    override hostPid(): number | null {
        return (this as unknown as { oc: unknown }).oc ? 4242 : null;
    }
}

test("a host whose process survives its close keeps reporting that process", async () => {
    const pi = new StubbornPi(ctx());
    Object.assign(pi as unknown as Record<string, unknown>, {
        rpc: {
            child: { pid: 4242, stdin: { end: () => undefined } },
            shutdown: async () => undefined,
        },
    });
    await expect(pi.closeSession()).rejects.toThrow("survived SIGKILL");
    expect(pi.hostPid()).toBe(4242);
    const oc = new StubbornOc(ctx());
    Object.assign(oc as unknown as Record<string, unknown>, {
        oc: { kill: async () => undefined },
    });
    await expect(oc.closeSession()).rejects.toThrow("survived SIGKILL");
    expect(oc.hostPid()).toBe(4242);
});
