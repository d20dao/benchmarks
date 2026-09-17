// Collects result files into results/summary.json (the file a website or report should cite) and prints a table.
// Usage: npm run summary [-- results/<run>.json ...]   Without arguments: the newest run of every scenario.
// Each entry keeps the SHA-256 of the result file it came from, so every number can be traced to a full record.
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {ROOT, sha256} from "./lib/common.mjs";

const argv = process.argv.slice(2);
const directory = path.join(ROOT, "results");
let files = argv.length
  ? argv.map((file) => path.resolve(file))
  : readdirSync(directory).filter((name) => name.endsWith(".json") && name !== "summary.json").map((name) => path.join(directory, name));
const loaded = files.map((file) => {
  const text = readFileSync(file, "utf8");
  return {file: path.relative(ROOT, file).replaceAll("\\", "/"), sha256: sha256(text), result: JSON.parse(text)};
});
if (!argv.length) {
  const newest = new Map();
  for (const entry of loaded) {
    const current = newest.get(entry.result.scenario.name);
    if (!current || current.result.startedAt < entry.result.startedAt) newest.set(entry.result.scenario.name, entry);
  }
  files = [...newest.values()];
} else {
  files = loaded;
}
const scenarioOrder = ["sequential-20", "burst-50", "burst-200", "sustained-5rps-40s"];
files.sort((a, b) => (scenarioOrder.indexOf(a.result.scenario.name) + 99) % 99 - (scenarioOrder.indexOf(b.result.scenario.name) + 99) % 99 || a.result.startedAt.localeCompare(b.result.startedAt));

const runs = files.map(({file, sha256: digest, result}) => ({
  file,
  sha256: digest,
  runId: result.runId,
  scenario: result.scenario,
  startedAt: result.startedAt,
  finishedAt: result.finishedAt,
  summary: result.summary,
  environment: {
    network: result.environment.network,
    chainId: result.environment.chainId,
    rpcForReads: result.environment.rpcForReads,
    coordinatorProxy: result.environment.coordinatorProxy,
    coordinatorImplementation: result.environment.coordinatorImplementation,
    manifest: result.environment.manifest,
    pricing: result.environment.pricing,
    consumer: result.environment.consumer,
    sender: result.environment.sender,
    software: result.environment.software,
    script: result.environment.script,
    localClockMinusChainSecondsAtStart: result.environment.localClockMinusChainSecondsAtStart,
  },
  firstRequestTx: result.requestTransactions[0]?.hash ?? null,
  firstFulfillmentTx: result.fulfillmentTransactions[0]?.hash ?? null,
}));
const keeper = files[0]?.result.environment.keeper ?? null;
const commits = [...new Set(runs.map((run) => run.environment.script.commit))];
const output = {
  schema: "d20dao-benchmark-summary/1",
  repository: "https://github.com/d20dao/benchmarks",
  generatedAt: new Date().toISOString(),
  scriptCommits: commits,
  anyDirtyRun: runs.some((run) => run.environment.script.dirty),
  keeper,
  runs,
};
writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(output, null, 2)}\n`);

const row = (cells) => `| ${cells.join(" | ")} |`;
console.log(row(["scenario", "requests", "per tx", "request blocks", "success", "p50 s", "p95 s", "p99 s", "max s", "fulfil txs", "members/tx", "fulfil/s", "chain s"]));
console.log(row(Array(13).fill("---")));
for (const run of runs) {
  const s = run.summary;
  console.log(row([
    run.scenario.name, s.requests.opened, s.requests.requestsPerTransaction, s.requests.requestBlocks,
    `${(s.outcome.successRate * 100).toFixed(1)}%`, s.latencySeconds.p50, s.latencySeconds.p95, s.latencySeconds.p99, s.latencySeconds.max,
    s.batching.fulfillmentTransactions, `${s.batching.meanMembersPerTransaction} (max ${s.batching.maxMembersPerTransaction})`,
    s.throughput.fulfillmentsPerSecond ?? "n/a", s.duration.chainSeconds,
  ]));
}
console.log(`\nwrote results/summary.json from ${runs.length} run(s); script commits: ${commits.join(", ")}`);
