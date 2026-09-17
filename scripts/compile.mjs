// Compiles contracts/LoadConsumer.sol with solc-js 0.8.28 (evmVersion cancun, optimizer 200 runs) and writes
// artifacts/LoadConsumer.json. SDK imports resolve from node_modules/@d20dao/vrf-sdk.
// Usage: npm run compile [-- --check]   (--check fails if the committed artifact differs)
import {readFileSync, writeFileSync, existsSync} from "node:fs";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import solc from "solc";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const SOURCE = "contracts/LoadConsumer.sol";
const SETTINGS = {evmVersion: "cancun", optimizer: {enabled: true, runs: 200}, outputSelection: {"*": {"*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "metadata"]}}};

const sources = {};
const readSource = (name) => {
  if (name.startsWith("@d20dao/vrf-sdk/")) return readFileSync(require.resolve(name), "utf8");
  return readFileSync(path.join(root, name), "utf8");
};
sources[SOURCE] = {content: readSource(SOURCE)};
const input = {language: "Solidity", sources, settings: SETTINGS};
const findImports = (name) => {
  try { return {contents: readSource(name)}; } catch (error) { return {error: `Cannot resolve ${name}: ${error.message}`}; }
};
const output = JSON.parse(solc.compile(JSON.stringify(input), {import: findImports}));
const errors = (output.errors ?? []).filter((e) => e.severity === "error");
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
if (!solc.version().startsWith("0.8.28+")) throw new Error(`expected solc 0.8.28, got ${solc.version()}`);

const contract = output.contracts[SOURCE].LoadConsumer;
const metadata = JSON.parse(contract.metadata);
const artifact = {
  contractName: "LoadConsumer",
  sourceName: SOURCE,
  compiler: {name: "solc-js", version: solc.version(), settings: {evmVersion: SETTINGS.evmVersion, optimizer: SETTINGS.optimizer}},
  sources: Object.fromEntries(Object.keys(metadata.sources).sort().map((name) => [name, {sha256: sha256(readSource(name))}])),
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences,
};
const target = path.join(root, "artifacts/LoadConsumer.json");
const text = `${JSON.stringify(artifact, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== text) { console.error("artifacts/LoadConsumer.json is stale; run npm run compile"); process.exit(1); }
  console.log("artifact up to date");
} else {
  writeFileSync(target, text);
  console.log(`wrote artifacts/LoadConsumer.json (${(artifact.deployedBytecode.length - 2) / 2} bytes runtime)`);
}
