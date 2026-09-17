// Runs the published scenarios in order with a pause between them, and stops at the first run that reports a
// refund, an expired request, an aborted run or a script error (bench.mjs exits non-zero).
// Usage: BENCH_PRIVATE_KEY_FILE=/path/to/testnet.key npm run suite [-- --gap 120] [-- scenario ...]
import {spawnSync} from "node:child_process";
import path from "node:path";
import {ROOT, sleep} from "./lib/common.mjs";

const args = process.argv.slice(2);
const gapIndex = args.indexOf("--gap");
const gapSeconds = gapIndex >= 0 ? Number(args.splice(gapIndex, 2)[1]) : 120;
if (!(gapSeconds >= 90)) throw new Error("keep at least 90 seconds between scenarios on the shared testnet keeper");
const scenarios = args.length ? args : ["sequential-20", "burst-50", "burst-200", "sustained-5rps-40s"];

for (const [index, name] of scenarios.entries()) {
  if (index > 0) {
    console.log(JSON.stringify({t: new Date().toISOString(), phase: "gap", seconds: gapSeconds, next: name}));
    await sleep(gapSeconds * 1000);
  }
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts/bench.mjs"), name], {cwd: ROOT, stdio: "inherit", env: process.env});
  if (run.status !== 0) {
    console.error(JSON.stringify({t: new Date().toISOString(), phase: "stopped", scenario: name, exitCode: run.status}));
    process.exit(run.status ?? 1);
  }
}
console.log(JSON.stringify({t: new Date().toISOString(), phase: "suite-complete", scenarios}));
