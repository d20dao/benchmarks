// Deploys LoadConsumer (artifacts/LoadConsumer.json) on Arc Testnet from the benchmark wallet and records it in
// deployments/arc-testnet.json. The coordinator proxy is taken from config and must match the public manifest.
// Usage: BENCH_PRIVATE_KEY_FILE=/path/to/testnet.key npm run deploy
import {writeFileSync, existsSync} from "node:fs";
import path from "node:path";
import {ContractFactory, Contract, getAddress, keccak256} from "ethers";
import {ROOT, readJson, loadConfig, loadWallet, makeProvider, fetchManifest, readImplementation, gitState, packageVersion, toUsdc, withRetry} from "./lib/common.mjs";

const config = loadConfig();
const target = path.join(ROOT, "deployments/arc-testnet.json");
if (existsSync(target) && !process.argv.includes("--force")) {
  console.error("deployments/arc-testnet.json exists; reuse that consumer or pass --force to deploy a new one");
  process.exit(1);
}
const provider = makeProvider(config.rpcUrls[0], config.chainId);
const wallet = loadWallet(provider);
const {json: manifest, sha256: manifestSha256} = await fetchManifest(config.manifestUrl);
if (Number(manifest.chainId) !== config.chainId || getAddress(manifest.coordinator) !== getAddress(config.coordinator)) {
  throw new Error("config coordinator/chain does not match the public manifest");
}
const chainId = Number((await provider.getNetwork()).chainId);
const remoteChainId = Number(await provider.send("eth_chainId", []));
if (remoteChainId !== config.chainId || chainId !== config.chainId) throw new Error(`RPC chain ${remoteChainId} is not ${config.chainId}`);

const artifact = readJson("artifacts/LoadConsumer.json");
/** Zeroes immutable values so deployed runtime code can be compared byte for byte with the compiler output. */
function maskImmutables(runtime, references) {
  const bytes = Buffer.from(runtime.slice(2), "hex");
  for (const ranges of Object.values(references)) for (const {start, length} of ranges) bytes.fill(0, start, start + length);
  return `0x${bytes.toString("hex")}`;
}
const balanceBefore = await provider.getBalance(wallet.address);
console.log(JSON.stringify({phase: "deploy", sender: wallet.address, balanceUsdc: toUsdc(balanceBefore), coordinator: config.coordinator}));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const contract = await factory.deploy(config.coordinator);
const tx = contract.deploymentTransaction();
const receipt = await tx.wait();
const address = await contract.getAddress();
const deployed = new Contract(address, artifact.abi, provider);
const [code, coordinator, owner] = await withRetry("verify deployment", () => Promise.all([provider.getCode(address), deployed.vrfCoordinator(), deployed.owner()]));
if (maskImmutables(code, artifact.immutableReferences) !== artifact.deployedBytecode.toLowerCase()) {
  throw new Error("deployed runtime code does not match the artifact");
}
const record = {
  network: config.network,
  chainId: config.chainId,
  contract: "LoadConsumer",
  address,
  coordinator,
  owner,
  deploymentTx: tx.hash,
  block: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  effectiveGasPriceWei: receipt.gasPrice.toString(),
  runtimeCodeKeccak256: keccak256(code),
  artifactDeployedBytecodeKeccak256: keccak256(artifact.deployedBytecode),
  compiler: artifact.compiler,
  sdkVersion: packageVersion("@d20dao/vrf-sdk"),
  coordinatorImplementation: await readImplementation(provider, config.coordinator, receipt.blockNumber),
  manifestSha256,
  scriptCommit: gitState().commit,
  deployedAt: new Date().toISOString(),
};
writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({phase: "deployed", address, tx: tx.hash, block: receipt.blockNumber, gasUsed: record.gasUsed, costUsdc: toUsdc(receipt.gasUsed * receipt.gasPrice)}));
provider.destroy();
