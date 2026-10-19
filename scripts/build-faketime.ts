import { buildFaketime } from "../src/run/timeinject";

// Run as a supervised child of the tier command, so a signal to the tier ends the build too.
// Each build stages in a directory of its own, so an interrupted build leaves no partial library.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));
}
console.log(await buildFaketime());
