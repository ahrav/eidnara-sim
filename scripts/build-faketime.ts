import { buildFaketime } from "../src/run/timeinject";

// Run as a supervised child of the tier command, so a signal to the tier ends the build too.
console.log(await buildFaketime());
