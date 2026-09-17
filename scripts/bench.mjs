// Runs one named load scenario against the D20DAO VRF coordinator on Arc Testnet and writes a results JSON file.
// Usage: BENCH_PRIVATE_KEY_FILE=/path/to/testnet.key npm run bench -- <scenario> [--dry-run]
// Scenarios live in config/scenarios.json. Every number in the output is derived from chain data (receipts, logs,
// block headers, coordinator state) except wall-clock fields, which are measured by this process.
import {mkdirSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {Contract, Interface, Transaction, getAddress, keccak256} from "ethers";
import {coordinatorAbi, epochEntropyAbi} from "@d20dao/vrf-sdk/abi";
import {quoteRequestFee} from "@d20dao/vrf-sdk";
import {
  ROOT, readJson, loadConfig, loadWallet, makeProvider, withRetry, pool, rawRpc, broadcastRaw, waitForReceipt,
  fetchManifest, readImplementation, packageVersion, gitState, runTagFor, sleep, toUsdc, toGwei, distribution,
  median, mean, round,
} from "./lib/common.mjs";

const scenarioName = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const scenarios = readJson("config/scenarios.json");
const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`Unknown scenario "${scenarioName}". Available: ${Object.keys(scenarios).join(", ")}`);
  process.exit(1);
}
const config = loadConfig();
const keeperDeclared = readJson("config/keeper-arc-testnet.json");
const deployment = readJson("deployments/arc-testnet.json");
const artifact = readJson("artifacts/LoadConsumer.json");
const log = (phase, data = {}) => console.log(JSON.stringify({t: new Date().toISOString(), phase, ...data}));

const RPC = config.rpcUrls[0];
const provider = makeProvider(RPC, config.chainId);
const wallet = loadWallet(provider);
const coordinatorAddress = getAddress(config.coordinator);
const coordinatorIface = new Interface(coordinatorAbi);
const registryIface = new Interface(epochEntropyAbi);
const coordinator = new Contract(coordinatorAddress, coordinatorAbi, provider);
const consumer = new Contract(deployment.address, artifact.abi, provider);
const CALLBACK_GAS = config.callbackGasLimit;
const topic = (name) => coordinatorIface.getEvent(name).topicHash;

// ---- preflight --------------------------------------------------------------------------------------------------

const startedAt = new Date();
const runId = `${scenarioName}-${startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
const runTag = runTagFor(runId);
const git = gitState();
const {json: manifest, sha256: manifestSha256} = await fetchManifest(config.manifestUrl);
if (Number(manifest.chainId) !== config.chainId || getAddress(manifest.coordinator) !== coordinatorAddress) {
  throw new Error("config coordinator/chain does not match the public manifest");
}
const remoteChainId = Number(await withRetry("chainId", () => provider.send("eth_chainId", [])));
if (remoteChainId !== config.chainId) throw new Error(`RPC reports chain ${remoteChainId}, expected ${config.chainId}`);
if (getAddress(deployment.owner) !== wallet.address) throw new Error("benchmark wallet is not the LoadConsumer owner");

const [implementationAtStart, pricing, keeperFeeBps, deliveredBefore, balanceBefore, nonceLatest, noncePending, startHead, code] =
  await withRetry("preflight reads", () => Promise.all([
    readImplementation(provider, coordinatorAddress),
    coordinator.pricing(),
    coordinator.keeperFeeBps(),
    consumer.delivered(),
    provider.getBalance(wallet.address),
    provider.getTransactionCount(wallet.address, "latest"),
    provider.getTransactionCount(wallet.address, "pending"),
    provider.getBlock("latest"),
    provider.getCode(deployment.address),
  ]));
if (keccak256(code) !== deployment.runtimeCodeKeccak256) throw new Error("LoadConsumer runtime code differs from deployments/arc-testnet.json");
if (nonceLatest !== noncePending) throw new Error(`wallet has ${noncePending - nonceLatest} pending transactions; wait until they settle`);
const plannedRequests = scenario.mode === "sustained" ? scenario.ratePerSecond * scenario.durationSeconds : scenario.requests;
const firstQuote = await quoteRequestFee(provider, coordinatorAddress, CALLBACK_GAS, {bufferBps: config.feeBufferBps});
const estimatedSpend = firstQuote.value * BigInt(plannedRequests) + BigInt(plannedRequests) * 250_000n * startHead.baseFeePerGas * 2n;
if (toUsdc(estimatedSpend) > config.maxSpendUsdcPerRun) throw new Error(`estimated spend ${toUsdc(estimatedSpend)} USDC exceeds maxSpendUsdcPerRun`);
if (estimatedSpend > balanceBefore) throw new Error(`balance ${toUsdc(balanceBefore)} USDC is below the estimated ${toUsdc(estimatedSpend)} USDC`);
const tipResult = await rawRpc(RPC, "eth_maxPriorityFeePerGas", []);
const priorityFee = tipResult.result ? BigInt(tipResult.result) : 1_000_000_000n;
const maxFeeCap = BigInt(config.maxFeePerGasGwei) * 1_000_000_000n;
log("preflight", {
  runId, scenario: scenarioName, mode: scenario.mode, plannedRequests, sender: wallet.address, consumer: deployment.address,
  balanceUsdc: toUsdc(balanceBefore), baseFeeGwei: toGwei(startHead.baseFeePerGas), priorityFeeGwei: toGwei(priorityFee),
  feeQuoteUsdc: toUsdc(firstQuote.fee), sendValuePerRequestUsdc: toUsdc(firstQuote.value), estimatedSpendUsdc: toUsdc(estimatedSpend),
  implementation: implementationAtStart, manifestImplementation: manifest.coordinatorImplementation, git,
});

// ---- fulfillment watcher (wall-clock observation) ------------------------------------------------------------------

/** Polls coordinator RandomnessFulfilled logs and remembers when this process first saw each request ID fulfilled. */
function startWatcher(fromBlock) {
  const seen = new Map();
  const errors = [];
  let scannedTo = fromBlock - 1;
  let stopped = false;
  const OVERLAP = 6; // rescan a few blocks: load-balanced RPC nodes can briefly disagree about the head
  const loop = (async () => {
    while (!stopped) {
      const tick = Date.now();
      try {
        const head = await provider.getBlockNumber();
        if (head > scannedTo) {
          const from = Math.max(fromBlock, scannedTo + 1 - OVERLAP);
          const to = Math.min(head, from + 999);
          const logs = await provider.getLogs({address: coordinatorAddress, fromBlock: from, toBlock: to, topics: [topic("RandomnessFulfilled")]});
          const now = Date.now();
          for (const entry of logs) {
            const id = BigInt(entry.topics[1]).toString();
            if (!seen.has(id)) seen.set(id, {observedAtMs: now, block: entry.blockNumber, tx: entry.transactionHash});
          }
          scannedTo = to;
        }
      } catch (error) {
        if (errors.length < 20) errors.push(String(error.shortMessage ?? error.message).slice(0, 120));
      }
      await sleep(Math.max(0, config.pollIntervalMs - (Date.now() - tick)));
    }
  })();
  return {seen, errors, stop: async () => { stopped = true; await loop; }};
}

// ---- request transactions ----------------------------------------------------------------------------------------

let nonce = nonceLatest;
const requestTxs = [];

async function feeFields() {
  const block = await withRetry("latest block", () => provider.getBlock("latest"));
  const maxFeePerGas = block.baseFeePerGas * 2n + priorityFee;
  if (maxFeePerGas > maxFeeCap) throw new Error(`maxFeePerGas ${toGwei(maxFeePerGas)} gwei exceeds the configured cap`);
  return {maxFeePerGas, maxPriorityFeePerGas: priorityFee};
}

async function estimateOpenGas(count, valuePerRequest) {
  const data = consumer.interface.encodeFunctionData("open", [count, CALLBACK_GAS, runTag]);
  const estimate = await withRetry("estimateGas", () => provider.estimateGas({from: wallet.address, to: deployment.address, data, value: valuePerRequest * BigInt(count)}));
  // Margin: the first request of an epoch writes extra checkpoint state that an earlier estimate may not include.
  return estimate + estimate * 3n / 10n + 150_000n;
}

async function signOpen(count, valuePerRequest, gasLimit, fees) {
  const data = consumer.interface.encodeFunctionData("open", [count, CALLBACK_GAS, runTag]);
  const raw = await wallet.signTransaction({
    type: 2, chainId: config.chainId, nonce: nonce++, to: deployment.address, data, value: valuePerRequest * BigInt(count),
    gasLimit, ...fees,
  });
  return {raw, hash: Transaction.from(raw).hash, count, nonce: nonce - 1, valuePerRequest};
}

/** Broadcasts a signed open() and resolves once its receipt is observed. */
async function sendAndTrack(signed, index) {
  const entry = {index, hash: signed.hash, nonce: signed.nonce, count: signed.count, valuePerRequestWei: signed.valuePerRequest.toString()};
  requestTxs.push(entry);
  const sent = await broadcastRaw(signed.raw, config.rpcUrls);
  Object.assign(entry, {broadcastAtMs: sent.startedAtMs, acceptedAtMs: sent.acceptedAtMs, acceptedBy: sent.acceptedBy, broadcastAttempts: sent.attempts, broadcastErrors: sent.errors});
  // A failed answer can still hide an earlier attempt that reached the mempool, so look for a receipt briefly.
  const {receipt, observedAtMs} = await waitForReceipt(provider, signed.hash, sent.ok ? 90_000 : 8_000);
  entry.receipt = receipt;
  entry.receiptObservedAtMs = observedAtMs;
  return entry;
}

const ourRequestIds = (receipt) => receipt.logs
  .filter((entry) => getAddress(entry.address) === coordinatorAddress && entry.topics[0] === topic("RandomnessRequested"))
  .map((entry) => coordinatorIface.parseLog(entry))
  .filter((event) => getAddress(event.args.consumer) === getAddress(deployment.address));

if (dryRun) {
  const count = scenario.perTx;
  const gasLimit = await estimateOpenGas(count, firstQuote.value);
  log("dry-run", {perTx: count, gasLimit: gasLimit.toString(), valuePerTxUsdc: toUsdc(firstQuote.value * BigInt(count))});
  provider.destroy();
  process.exit(0);
}

const watcher = startWatcher(startHead.number + 1);
const runStartMs = Date.now();
const skippedTicks = [];
let aborted = null;

if (scenario.mode === "burst") {
  const quote = firstQuote;
  const plan = Array.from({length: Math.ceil(scenario.requests / scenario.perTx)}, (_, i) => Math.min(scenario.perTx, scenario.requests - i * scenario.perTx));
  const gasLimit = await estimateOpenGas(plan[0], quote.value);
  const fees = await feeFields();
  const signed = [];
  for (const count of plan) signed.push(await signOpen(count, quote.value, gasLimit, fees));
  log("signed", {transactions: signed.length, plan, gasLimit: gasLimit.toString(), maxFeeGwei: toGwei(fees.maxFeePerGas)});
  await Promise.all(signed.map((tx, i) => sendAndTrack(tx, i)));
} else if (scenario.mode === "sequential") {
  const gasLimit = await estimateOpenGas(scenario.perTx, firstQuote.value);
  for (let i = 0; i < scenario.requests / scenario.perTx; i++) {
    const quote = await quoteRequestFee(provider, coordinatorAddress, CALLBACK_GAS, {bufferBps: config.feeBufferBps});
    const tx = await signOpen(scenario.perTx, quote.value, gasLimit, await feeFields());
    const entry = await sendAndTrack(tx, i);
    if (!entry.receipt || entry.receipt.status !== 1) { aborted = `request transaction ${tx.hash} failed or was not observed`; break; }
    const ids = ourRequestIds(entry.receipt).map((event) => event.args.requestId.toString());
    // Wait for every request in this transaction to be observed fulfilled, or for its 60 s deadline to pass
    // (measured locally from receipt observation, plus a margin, to avoid extra RPC polling).
    const giveUpAtMs = entry.receiptObservedAtMs + 65_000;
    while (!ids.every((id) => watcher.seen.has(id)) && Date.now() < giveUpAtMs) await sleep(250);
    log("sequential", {index: i + 1, of: scenario.requests / scenario.perTx, requestIds: ids, fulfilled: ids.every((id) => watcher.seen.has(id))});
  }
} else if (scenario.mode === "sustained") {
  const intervalMs = (scenario.perTx / scenario.ratePerSecond) * 1000;
  const ticks = Math.round((scenario.ratePerSecond * scenario.durationSeconds) / scenario.perTx);
  let quote = firstQuote;
  let fees = await feeFields();
  const gasLimit = await estimateOpenGas(scenario.perTx, quote.value);
  const pending = [];
  const t0 = Date.now() + 500;
  for (let k = 0; k < ticks; k++) {
    const target = t0 + k * intervalMs;
    await sleep(Math.max(0, target - Date.now()));
    if (k > 0 && k % 10 === 0) {
      quote = await quoteRequestFee(provider, coordinatorAddress, CALLBACK_GAS, {bufferBps: config.feeBufferBps});
      fees = await feeFields();
    }
    const unconfirmed = requestTxs.filter((tx) => tx.receipt === undefined).length;
    if (unconfirmed >= 12) { // Arc Testnet keeps only about 16 pending transactions per sender
      skippedTicks.push({tick: k, unconfirmed, atMs: Date.now() - runStartMs});
      continue;
    }
    const lateByMs = Date.now() - target;
    const tx = await signOpen(scenario.perTx, quote.value, gasLimit, fees);
    pending.push(sendAndTrack(tx, k).then((entry) => { entry.tick = k; entry.scheduleLagMs = lateByMs; return entry; }));
  }
  await Promise.all(pending);
}

// ---- inclusion ---------------------------------------------------------------------------------------------------

requestTxs.sort((a, b) => a.nonce - b.nonce);
const blockCache = new Map();
const getBlock = (number) => {
  if (!blockCache.has(number)) blockCache.set(number, withRetry(`block ${number}`, () => provider.getBlock(number)));
  return blockCache.get(number);
};

const requests = [];
for (const tx of requestTxs) {
  if (!tx.receipt) continue;
  tx.status = tx.receipt.status;
  tx.block = tx.receipt.blockNumber;
  tx.gasUsed = tx.receipt.gasUsed.toString();
  tx.effectiveGasPriceWei = tx.receipt.gasPrice.toString();
  if (tx.receipt.status !== 1) continue;
  const events = ourRequestIds(tx.receipt);
  tx.opened = events.length;
  const header = await getBlock(tx.receipt.blockNumber);
  tx.blockTimestamp = header.timestamp;
  for (const event of events) {
    requests.push({
      requestId: event.args.requestId.toString(),
      requestTx: tx.hash,
      requestBlock: tx.receipt.blockNumber,
      requestTimestamp: header.timestamp,
      deadline: Number(event.args.deadline),
      feePaidWei: event.args.feePaid.toString(),
      requestGasShare: Number(tx.receipt.gasUsed) / events.length,
      requestGasPriceWei: tx.receipt.gasPrice.toString(),
      broadcastAtMs: tx.broadcastAtMs,
      receiptObservedAtMs: tx.receiptObservedAtMs,
    });
  }
}
log("included", {
  requestTransactions: requestTxs.length, receipts: requestTxs.filter((t) => t.receipt).length,
  reverted: requestTxs.filter((t) => t.receipt && t.receipt.status !== 1).length, requests: requests.length,
  blocks: [...new Set(requests.map((r) => r.requestBlock))],
});
if (!requests.length) {
  await watcher.stop();
  log("aborted", {reason: aborted ?? "no request was opened", requestTransactions: requestTxs.map(({receipt, ...tx}) => tx)});
  provider.destroy();
  process.exit(2);
}

// ---- settlement --------------------------------------------------------------------------------------------------

const maxDeadline = Math.max(0, ...requests.map((r) => r.deadline));
const settleDeadlineMs = Date.now() + config.settleTimeoutSeconds * 1000;
for (;;) {
  const open = requests.filter((r) => !watcher.seen.has(r.requestId)).length;
  if (!open) break;
  const head = await withRetry("latest block", () => provider.getBlock("latest"));
  if (head.timestamp > maxDeadline + 3 || Date.now() > settleDeadlineMs) break;
  await sleep(1000);
}
await sleep(2 * config.pollIntervalMs + 1000); // let the watcher pass the last fulfillment block once more
await watcher.stop();
const settledAtMs = Date.now();

const states = await pool(requests, 6, (r) => withRetry(`getRequest ${r.requestId}`, () => Promise.all([
  coordinator.getRequest(r.requestId), consumer.deliveredBlock(r.requestId),
])));
const endHead = await withRetry("end head", () => provider.getBlock("latest"));
const [implementationAtEnd, deliveredAfter, balanceAfter] = await withRetry("end reads", () => Promise.all([
  readImplementation(provider, coordinatorAddress), consumer.delivered(), provider.getBalance(wallet.address),
]));

// ---- fulfillment evidence ----------------------------------------------------------------------------------------

const firstRequestBlock = Math.min(...requests.map((r) => r.requestBlock));
const scanFrom = Math.min(firstRequestBlock, startHead.number + 1);
const scanTo = endHead.number;
const fulfillmentTopics = ["RandomnessFulfilled", "CallbackAttempted", "FulfillmentSkipped", "KeeperFeePaid", "RequestRefundedTo"].map(topic);
const coordinatorLogs = [];
for (let from = scanFrom; from <= scanTo; from += 1000) {
  const to = Math.min(scanTo, from + 999);
  coordinatorLogs.push(...await withRetry("coordinator logs", () => provider.getLogs({address: coordinatorAddress, fromBlock: from, toBlock: to, topics: [fulfillmentTopics]})));
}
const registryLogs = [];
for (let from = scanFrom - 200; from <= scanTo; from += 1000) {
  const to = Math.min(scanTo, from + 999);
  registryLogs.push(...await withRetry("registry logs", () => provider.getLogs({address: manifest.registry, fromBlock: from, toBlock: to, topics: [registryIface.getEvent("EpochCommitted").topicHash]})));
}

const ours = new Set(requests.map((r) => r.requestId));
const byTx = new Map();
const perRequestEvents = new Map();
for (const entry of coordinatorLogs) {
  const event = coordinatorIface.parseLog(entry);
  const id = event.args.requestId.toString();
  const tx = byTx.get(entry.transactionHash) ?? {hash: entry.transactionHash, block: entry.blockNumber, fulfilled: [], skipped: [], callbacks: [], keeperFeeWei: 0n, oursKeeperFeeWei: 0n, refunds: []};
  if (event.name === "RandomnessFulfilled") tx.fulfilled.push({id, submitter: event.args.submitter});
  if (event.name === "FulfillmentSkipped") tx.skipped.push({id, reason: Number(event.args.reason)});
  if (event.name === "CallbackAttempted") tx.callbacks.push({id, success: event.args.success});
  if (event.name === "KeeperFeePaid") { tx.keeperFeeWei += event.args.amount; if (ours.has(id)) tx.oursKeeperFeeWei += event.args.amount; }
  if (event.name === "RequestRefundedTo") tx.refunds.push({id, amount: event.args.amount.toString(), paid: event.args.paid});
  byTx.set(entry.transactionHash, tx);
  if (ours.has(id)) {
    const record = perRequestEvents.get(id) ?? {};
    if (event.name === "RandomnessFulfilled") Object.assign(record, {fulfillmentTx: entry.transactionHash, fulfillmentBlock: entry.blockNumber});
    if (event.name === "CallbackAttempted") (record.callbacks ??= []).push(event.args.success);
    if (event.name === "KeeperFeePaid") record.keeperFeeWei = event.args.amount.toString();
    if (event.name === "FulfillmentSkipped") (record.skipped ??= []).push(Number(event.args.reason));
    if (event.name === "RequestRefundedTo") record.refund = {tx: entry.transactionHash, amountWei: event.args.amount.toString()};
    perRequestEvents.set(id, record);
  }
}

const batchSelector = coordinatorIface.getFunction("fulfillRandomnessBatch").selector;
const singleSelector = coordinatorIface.getFunction("fulfillRandomness").selector;
const fulfillmentTxs = [];
const otherFulfillmentTxs = [];
for (const tx of byTx.values()) {
  if (!tx.fulfilled.length && !tx.skipped.length) continue;
  const touchesOurs = tx.fulfilled.some((m) => ours.has(m.id)) || tx.skipped.some((m) => ours.has(m.id));
  if (!touchesOurs) { otherFulfillmentTxs.push(tx.hash); continue; }
  const [chainTx, receipt, header] = await withRetry(`fulfillment ${tx.hash}`, () => Promise.all([provider.getTransaction(tx.hash), provider.getTransactionReceipt(tx.hash), getBlock(tx.block)]));
  const selector = chainTx.data.slice(0, 10);
  const served = tx.fulfilled.length;
  fulfillmentTxs.push({
    hash: tx.hash,
    block: tx.block,
    timestamp: header.timestamp,
    kind: selector === batchSelector ? "fulfillRandomnessBatch" : selector === singleSelector ? "fulfillRandomness" : selector,
    from: chainTx.from,
    nonce: chainTx.nonce,
    members: served + tx.skipped.length,
    served,
    ourServed: tx.fulfilled.filter((m) => ours.has(m.id)).length,
    otherServed: tx.fulfilled.filter((m) => !ours.has(m.id)).length,
    skipped: tx.skipped,
    callbacksFailed: tx.callbacks.filter((c) => !c.success).length,
    gasUsed: Number(receipt.gasUsed),
    gasPerServedMember: served ? Math.round(Number(receipt.gasUsed) / served) : null,
    effectiveGasPriceWei: receipt.gasPrice.toString(),
    costWei: (receipt.gasUsed * receipt.gasPrice).toString(),
    keeperFeeWei: tx.keeperFeeWei.toString(),
    blockGasUsedRatio: round(Number(header.gasUsed) / Number(header.gasLimit), 4),
  });
}
fulfillmentTxs.sort((a, b) => a.block - b.block || a.nonce - b.nonce);
const fulfillmentByHash = new Map(fulfillmentTxs.map((tx) => [tx.hash, tx]));

const epochs = [];
for (const entry of registryLogs) {
  const event = registryIface.parseLog(entry);
  const header = await getBlock(entry.blockNumber);
  epochs.push({epochId: Number(event.args.epochId), commitTx: entry.transactionHash, commitBlock: entry.blockNumber, commitTimestamp: header.timestamp});
}

// ---- per-request records -----------------------------------------------------------------------------------------

const requestRecords = [];
for (let i = 0; i < requests.length; i++) {
  const r = requests[i];
  const [state, consumerDeliveredBlock] = states[i];
  const events = perRequestEvents.get(r.requestId) ?? {};
  const fulfillment = events.fulfillmentTx ? fulfillmentByHash.get(events.fulfillmentTx) : null;
  const seen = watcher.seen.get(r.requestId);
  const latencySeconds = fulfillment ? fulfillment.timestamp - r.requestTimestamp : null;
  requestRecords.push({
    requestId: r.requestId,
    requestTx: r.requestTx,
    requestBlock: r.requestBlock,
    requestTimestamp: r.requestTimestamp,
    deadline: r.deadline,
    epochId: Number(state.epochId),
    targetBlock: Number(state.targetBlock),
    feePaidWei: r.feePaidWei,
    requestGasShare: Math.round(r.requestGasShare),
    fulfillmentTx: events.fulfillmentTx ?? null,
    fulfillmentBlock: fulfillment?.block ?? null,
    fulfillmentTimestamp: fulfillment?.timestamp ?? null,
    batchMembers: fulfillment?.members ?? null,
    latencySeconds,
    latencyBlocks: fulfillment ? fulfillment.block - r.requestBlock : null,
    fulfilled: state.fulfilled,
    fulfilledWithinDeadline: Boolean(state.fulfilled && fulfillment && fulfillment.timestamp <= r.deadline),
    delivered: state.delivered,
    consumerDeliveredBlock: Number(consumerDeliveredBlock) || null,
    callbackAttempts: events.callbacks ?? [],
    keeperFeeWei: events.keeperFeeWei ?? null,
    refunded: state.refunded,
    expired: !state.fulfilled && endHead.timestamp > r.deadline,
    skippedReasons: events.skipped ?? [],
    wallClock: {
      broadcastToReceiptObservedMs: r.receiptObservedAtMs ? r.receiptObservedAtMs - r.broadcastAtMs : null,
      broadcastToFulfillmentObservedMs: seen ? seen.observedAtMs - r.broadcastAtMs : null,
    },
  });
}

// ---- block conditions --------------------------------------------------------------------------------------------

const fulfilledRecords = requestRecords.filter((r) => r.fulfillmentBlock != null);
const windowFrom = startHead.number;
const windowTo = Math.max(startHead.number, fulfilledRecords.length ? Math.max(...fulfilledRecords.map((r) => r.fulfillmentBlock)) : 0, ...requests.map((r) => r.requestBlock));
const windowNumbers = Array.from({length: windowTo - windowFrom + 1}, (_, i) => windowFrom + i);
const headers = await pool(windowNumbers, 8, (n) => getBlock(n));
const perSecond = new Map();
for (const h of headers) perSecond.set(h.timestamp, (perSecond.get(h.timestamp) ?? 0) + 1);
const spanSeconds = headers.at(-1).timestamp - headers[0].timestamp;
const gasRatios = headers.map((h) => Number(h.gasUsed) / Number(h.gasLimit));
const baseFees = headers.map((h) => toGwei(h.baseFeePerGas));
const blockConditions = {
  fromBlock: windowFrom,
  toBlock: windowTo,
  window: "from the chain head when the run started to the last block containing a request or a fulfillment of this run",
  blockCount: headers.length,
  spanSeconds,
  meanBlockIntervalSeconds: headers.length > 1 ? round(spanSeconds / (headers.length - 1), 3) : null,
  timestampResolutionSeconds: 1,
  medianBlocksPerTimestampSecond: median([...perSecond.values()]),
  medianBlockIntervalSecondsEstimate: round(1 / median([...perSecond.values()]), 3),
  baseFeeGwei: {min: Math.min(...baseFees), median: median(baseFees), max: Math.max(...baseFees)},
  gasUsedRatio: {mean: round(mean(gasRatios), 4), median: round(median(gasRatios), 4), max: round(Math.max(...gasRatios), 4)},
  blockGasLimit: headers[0].gasLimit.toString(),
  transactions: {total: headers.reduce((a, h) => a + h.transactions.length, 0), meanPerBlock: round(mean(headers.map((h) => h.transactions.length)), 2)},
};

// ---- summary -----------------------------------------------------------------------------------------------------

const perBlock = {};
for (const r of requests) perBlock[r.requestBlock] = (perBlock[r.requestBlock] ?? 0) + 1;
const latencies = fulfilledRecords.map((r) => r.latencySeconds);
const latencyBlocks = fulfilledRecords.map((r) => r.latencyBlocks);
const wallFulfil = requestRecords.map((r) => r.wallClock.broadcastToFulfillmentObservedMs).filter((v) => v != null).map((v) => v / 1000);
const wallInclusion = requestRecords.map((r) => r.wallClock.broadcastToReceiptObservedMs).filter((v) => v != null).map((v) => v / 1000);
const firstFulfillment = fulfillmentTxs[0];
const lastFulfillment = fulfillmentTxs.at(-1);
const activeWindowSeconds = firstFulfillment ? lastFulfillment.timestamp - firstFulfillment.timestamp : null;
const ourFulfilled = fulfilledRecords.length;
const openedTxs = requestTxs.filter((t) => t.status === 1);
const requestGasPerRequest = openedTxs.map((t) => Number(t.gasUsed) / t.opened);
const requestCostWei = openedTxs.reduce((a, t) => a + BigInt(t.gasUsed) * BigInt(t.effectiveGasPriceWei), 0n);
const feesWei = requests.reduce((a, r) => a + BigInt(r.feePaidWei), 0n);
const fulfilGasTotal = fulfillmentTxs.reduce((a, t) => a + t.gasUsed, 0);
const fulfilServedTotal = fulfillmentTxs.reduce((a, t) => a + t.served, 0);
const fulfilCostWei = fulfillmentTxs.reduce((a, t) => a + BigInt(t.costWei), 0n);
const keeperFeeOursWei = requestRecords.reduce((a, r) => a + BigInt(r.keeperFeeWei ?? 0), 0n);
const keeperIntervals = fulfillmentTxs.slice(1).map((t, i) => t.timestamp - fulfillmentTxs[i].timestamp);
const requestTimestamps = requests.map((r) => r.requestTimestamp);

const summary = {
  requests: {
    planned: plannedRequests,
    opened: requests.length,
    requestTransactions: requestTxs.length,
    requestTransactionsReverted: requestTxs.filter((t) => t.status === 0).length,
    requestTransactionsNotIncluded: requestTxs.filter((t) => !t.receipt).length,
    requestsPerTransaction: scenario.perTx,
    requestBlocks: Object.keys(perBlock).length,
    maxRequestsInOneBlock: Math.max(0, ...Object.values(perBlock)),
    requestSpanBlocks: requests.length ? Math.max(...requests.map((r) => r.requestBlock)) - firstRequestBlock + 1 : 0,
    requestSpanSeconds: requests.length ? Math.max(...requestTimestamps) - Math.min(...requestTimestamps) : 0,
    skippedTicks: skippedTicks.length,
  },
  outcome: {
    fulfilled: requestRecords.filter((r) => r.fulfilled).length,
    fulfilledWithinDeadline: requestRecords.filter((r) => r.fulfilledWithinDeadline).length,
    successRate: requests.length ? round(requestRecords.filter((r) => r.fulfilledWithinDeadline).length / requests.length, 4) : null,
    callbacksDelivered: requestRecords.filter((r) => r.delivered).length,
    consumerDeliveredCounterDelta: Number(deliveredAfter - deliveredBefore),
    callbackFailures: requestRecords.filter((r) => r.callbackAttempts.includes(false)).length,
    refunded: requestRecords.filter((r) => r.refunded).length,
    expiredUnfulfilled: requestRecords.filter((r) => r.expired).length,
    skippedMemberEvents: requestRecords.reduce((a, r) => a + r.skippedReasons.length, 0),
    aborted,
  },
  latencySeconds: {...distribution(latencies), basis: "fulfillment block timestamp minus request block timestamp (1 s resolution)"},
  latencyBlocks: {...distribution(latencyBlocks), basis: "fulfillment block number minus request block number"},
  wallClockSeconds: {
    broadcastToReceiptObserved: distribution(wallInclusion),
    broadcastToFulfillmentObserved: distribution(wallFulfil),
    basis: `this process: broadcast start to first observation through ${new URL(RPC).host}, polling every ${config.pollIntervalMs} ms`,
    missingObservations: requestRecords.length - wallFulfil.length,
  },
  batching: {
    fulfillmentTransactions: fulfillmentTxs.length,
    batchTransactions: fulfillmentTxs.filter((t) => t.kind === "fulfillRandomnessBatch").length,
    singleTransactions: fulfillmentTxs.filter((t) => t.kind === "fulfillRandomness").length,
    membersPerTransaction: fulfillmentTxs.map((t) => t.members),
    meanMembersPerTransaction: round(mean(fulfillmentTxs.map((t) => t.members)), 2),
    maxMembersPerTransaction: Math.max(0, ...fulfillmentTxs.map((t) => t.members)),
    otherConsumersServedInTheseTransactions: fulfillmentTxs.reduce((a, t) => a + t.otherServed, 0),
    otherFulfillmentTransactionsInWindow: otherFulfillmentTxs.length,
    secondsBetweenFulfillmentTransactions: distribution(keeperIntervals),
    submitters: [...new Set(fulfillmentTxs.map((t) => t.from))],
  },
  throughput: {
    fulfillments: ourFulfilled,
    firstFulfillmentTimestamp: firstFulfillment?.timestamp ?? null,
    lastFulfillmentTimestamp: lastFulfillment?.timestamp ?? null,
    activeWindowSeconds,
    fulfillmentsPerSecond: activeWindowSeconds ? round(ourFulfilled / activeWindowSeconds, 2) : null,
    basis: "this run's fulfilled requests divided by the seconds between the first and last fulfillment block timestamps",
    limitedBy: scenario.mode === "burst" ? "keeper and chain (all requests were open at once)" : "arrival rate of this scenario, not keeper capacity",
  },
  duration: {
    wallClockSeconds: round((settledAtMs - runStartMs) / 1000, 1),
    chainSeconds: lastFulfillment && requests.length ? lastFulfillment.timestamp - Math.min(...requestTimestamps) : null,
    chainBasis: "first request block timestamp to last fulfillment block timestamp",
  },
  gas: {
    callbackGasLimit: CALLBACK_GAS,
    requestGasPerRequest: distribution(requestGasPerRequest, 0),
    requestEffectiveGasPriceGwei: distribution(openedTxs.map((t) => toGwei(t.effectiveGasPriceWei)), 3),
    fulfillmentGasUsedPerTransaction: distribution(fulfillmentTxs.map((t) => t.gasUsed), 0),
    fulfillmentGasPerServedMember: {...distribution(fulfillmentTxs.filter((t) => t.served).map((t) => t.gasPerServedMember), 0), pooled: fulfilServedTotal ? Math.round(fulfilGasTotal / fulfilServedTotal) : null},
    fulfillmentEffectiveGasPriceGwei: distribution(fulfillmentTxs.map((t) => toGwei(t.effectiveGasPriceWei)), 3),
  },
  costUsdc: {
    user: {
      feePerRequest: requests.length ? round(toUsdc(feesWei) / requests.length, 6) : null,
      requestGasPerRequest: requests.length ? round(toUsdc(requestCostWei) / requests.length, 6) : null,
      totalPerRequest: requests.length ? round(toUsdc(feesWei + requestCostWei) / requests.length, 6) : null,
      note: "requests opened through LoadConsumer; one request per transaction (sequential) is the closest to a single application request",
    },
    keeper: {
      fulfillmentGasPerServedRequest: fulfilServedTotal ? round(toUsdc(fulfilCostWei) / fulfilServedTotal, 6) : null,
      feeSharePerRequest: ourFulfilled ? round(toUsdc(keeperFeeOursWei) / ourFulfilled, 6) : null,
      netPerRequest: ourFulfilled && fulfilServedTotal ? round(toUsdc(keeperFeeOursWei) / ourFulfilled - toUsdc(fulfilCostWei) / fulfilServedTotal, 6) : null,
    },
    run: {
      feesPaid: round(toUsdc(feesWei), 6),
      requestGas: round(toUsdc(requestCostWei), 6),
      walletBalanceBefore: toUsdc(balanceBefore),
      walletBalanceAfter: toUsdc(balanceAfter),
      walletSpent: round(toUsdc(balanceBefore - balanceAfter), 6),
    },
  },
  epochs: {
    epochIds: [...new Set(requestRecords.map((r) => r.epochId))],
    requestsWaitingForEpochPublication: requestRecords.filter((r) => r.targetBlock > r.requestBlock).length,
    basis: "targetBlock = max(requestBlock, epoch commit block + 1); a later target means the request waited for its epoch packet to be published",
  },
  blocks: blockConditions,
};

const result = {
  schema: "d20dao-benchmark-result/1",
  runId,
  scenario: {name: scenarioName, ...scenario},
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  summary,
  environment: {
    network: config.network,
    chainId: config.chainId,
    rpcForReads: RPC,
    broadcastEndpoints: config.rpcUrls,
    coordinatorProxy: coordinatorAddress,
    coordinatorImplementation: {atStart: implementationAtStart, atEnd: implementationAtEnd, readFrom: "ERC-1967 implementation slot", matchesManifest: implementationAtStart.toLowerCase() === manifest.coordinatorImplementation.toLowerCase() && implementationAtEnd.toLowerCase() === manifest.coordinatorImplementation.toLowerCase()},
    manifest: {url: config.manifestUrl, sha256: manifestSha256, contractSourceCommit: manifest.contractSourceCommit, keeper: manifest.keeper, registry: manifest.registry},
    pricing: {minFeeWei: pricing[0].toString(), feeMultiplier: Number(pricing[1]), fulfillGasOverhead: Number(pricing[2]), keeperFeeBps: Number(keeperFeeBps)},
    keeper: keeperDeclared,
    consumer: {address: deployment.address, deploymentTx: deployment.deploymentTx, runtimeCodeKeccak256: deployment.runtimeCodeKeccak256, compiler: artifact.compiler.version},
    sender: wallet.address,
    runTag,
    software: {sdk: `@d20dao/vrf-sdk@${packageVersion("@d20dao/vrf-sdk")}`, ethers: packageVersion("ethers"), solc: packageVersion("solc"), node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`},
    script: {repository: "https://github.com/d20dao/benchmarks", commit: git.commit, dirty: git.dirty, dirtyFiles: git.dirtyFiles},
    watcherErrors: watcher.errors,
  },
  requestTransactions: requestTxs.map(({receipt, ...tx}) => tx),
  fulfillmentTransactions: fulfillmentTxs,
  epochsCommittedNearRun: epochs,
  requests: requestRecords,
  skippedTicks,
};

const directory = path.join(ROOT, scenarioName === "smoke" ? "results/smoke" : "results");
mkdirSync(directory, {recursive: true});
const file = path.join(directory, `${runId}.json`);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
log("summary", {file: path.relative(ROOT, file), requests: summary.requests, outcome: summary.outcome, latencySeconds: summary.latencySeconds, batching: {...summary.batching, secondsBetweenFulfillmentTransactions: undefined}, throughput: summary.throughput, costUsdc: summary.costUsdc.run});
provider.destroy();
if (summary.outcome.refunded || summary.outcome.expiredUnfulfilled || aborted) process.exitCode = 2;
