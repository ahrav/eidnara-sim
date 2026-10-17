import { releaseLease } from "../src/run/journal";
import { buildFaketime, VENDOR } from "../src/run/timeinject";

// Run as a supervised child of the tier command, so a signal to the tier ends the build too; the
// signal releases the vendor lease this process holds, and leaves another holder's in place.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
        releaseLease(VENDOR);
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}
console.log(await buildFaketime());
