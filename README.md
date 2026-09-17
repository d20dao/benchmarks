# D20DAO VRF benchmarks

Reproducible load tests for the [D20DAO](https://d20dao.org) verifiable randomness service on **Arc Testnet** (chain 5042002). A small consumer contract opens paid requests against the public coordinator proxy, and a Node script records how the keeper serves them: completion latency in chain time and wall-clock time, success within the 60-second deadline, fulfillment batch sizes, throughput, gas, USDC cost and Arc block conditions during the run.

Everything here uses public inputs only: the npm package [`@d20dao/vrf-sdk`](https://www.npmjs.com/package/@d20dao/vrf-sdk) 0.3.3 (coordinator ABI and `quoteRequestFee`), the public deployment manifest <https://d20dao.org/deployments/arc-testnet.json> and public Arc RPC endpoints. Every result can be checked on [Arcscan](https://testnet.arcscan.app) from the transaction hashes in the result files.

Results are measurements of one testnet keeper at one point in time. They are **not an SLA** and not a mainnet capacity claim; see [Limitations](#limitations).

## Results

See [Published runs](#published-runs) below and `results/summary.json`. Each scenario has one full result file in `results/`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `contracts/LoadConsumer.sol` | MIT load consumer (Solidity 0.8.28, `evmVersion` cancun). Extends the SDK's `D20VRFConsumer`; `open(count, callbackGasLimit, runTag)` opens up to 100 paid raw requests in one transaction, pays the exact in-transaction `quoteFee` for each, returns unused value and records every authenticated callback in `deliveredBlock(requestId)`. The owner (benchmark wallet) is the refund address. |
| `artifacts/LoadConsumer.json` | solc-js 0.8.28 output (optimizer 200 runs) with source SHA-256s and immutable references. |
| `deployments/arc-testnet.json` | The deployed consumer, its deployment transaction and runtime code hash. |
| `config/arc-testnet.json` | Chain ID, manifest URL, coordinator proxy, RPC endpoints, callback gas (100,000), fee buffer and safety caps. |
| `config/scenarios.json` | Scenario definitions. |
| `config/keeper-arc-testnet.json` | Keeper hardware and settings **as declared by the operator** (not measurable from chain data). |
| `scripts/compile.mjs` | Compiles the contract (`--check` verifies the committed artifact). |
| `scripts/deploy.mjs` | Deploys the consumer and verifies its runtime code byte for byte. |
| `scripts/bench.mjs` | Runs one scenario and writes `results/<scenario>-<UTC time>.json`. |
| `scripts/suite.mjs` | Runs the four scenarios with a pause between them and stops on refunds, expiries or errors. |
| `scripts/summary.mjs` | Writes `results/summary.json` (newest run per scenario, with each source file's SHA-256) and prints a table. |

## Scenarios

| Name | Load | Why |
| --- | --- | --- |
| `sequential-20` | 20 requests, one per transaction; the next is sent after the previous one is fulfilled (or its deadline passes). | Baseline latency for an isolated request. |
| `burst-50` | 50 requests in one transaction, so all 50 share one block. | Batching behaviour for a burst that needs several 16-member fulfillments. |
| `burst-200` | 200 requests in four 50-request transactions broadcast together (about 11M gas each, so at least two 30M-gas blocks). | Queueing under a large simultaneous burst; the keeper's sustained serving rate when every request is already open. |
| `sustained-5rps-45s` | One 5-request transaction every second for 45 seconds (225 requests). | Steady arrivals below the burst serving rate. 45 s instead of 60 s keeps the suite near 500 paid requests. |

Why a contract: Arc Testnet keeps only about 16 pending transactions per sender, and the coordinator accepts requests only from contracts. Opening many requests per transaction is the only way for one wallet to create concurrent load.

## Reproduce

Requirements: Node 22.13 or newer (the SDK's minimum), npm, and an Arc Testnet wallet holding test USDC. The native gas token on Arc is USDC with 18 decimals; test USDC comes from the faucet linked in Arc's [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc) reference.

1. **Install and compile**

   ```sh
   npm ci
   npm run compile -- --check   # or npm run compile to rebuild the artifact
   ```

2. **Fund a dedicated testnet wallet.** Use a fresh key that holds nothing else. At the initialized pricing (0.08 USDC minimum fee per request, 100,000 callback gas, base fee near 20 gwei) the full suite of 495 requests costs about 43 USDC: 39.6 USDC in request fees plus request gas. Put the key in a file outside the repository (`*.key` is git-ignored anyway):

   ```sh
   export BENCH_PRIVATE_KEY_FILE=/secure/path/arc-testnet-bench.key
   ```

   `BENCH_PRIVATE_KEY` also works; the scripts never print the key.

3. **Deploy your own consumer** (only the owner can open requests with it). This replaces `deployments/arc-testnet.json`:

   ```sh
   npm run deploy -- --force
   ```

4. **Run.** Check a scenario without sending transactions, then run it or the whole suite:

   ```sh
   npm run bench -- burst-50 --dry-run
   npm run bench -- burst-50
   npm run suite              # all four, 120 s apart; stops on refunds, expiries or errors
   npm run summary            # results/summary.json and a Markdown table
   ```

   The testnet keeper is shared with other applications. Keep bursts at or below 200 requests, leave at least 90 seconds between scenarios, and stop if requests expire.

Preflight refuses to run when the RPC chain ID, the manifest's coordinator proxy or the consumer's runtime code do not match, when the wallet has pending transactions, or when the estimated spend exceeds `maxSpendUsdcPerRun` (25 USDC) or the balance.

## What a result file contains

All values derived from the chain come from receipts, coordinator and registry logs, block headers and `getRequest` state read after settlement. Wall-clock values are measured by the machine running the script.

**`summary.requests`**: `planned`, `opened` (RandomnessRequested events from this consumer), `requestTransactions`, `requestsPerTransaction`, `requestBlocks` (distinct blocks holding this run's requests, the concurrency measure), `maxRequestsInOneBlock`, `requestSpanBlocks`, `requestSpanSeconds` and, for the sustained scenario, `skippedTicks` (ticks skipped because 12 or more of the wallet's transactions were unconfirmed).

**`summary.outcome`**: `fulfilled`; `fulfilledWithinDeadline` (fulfillment block timestamp at or before the request's `deadline`); `successRate` = fulfilledWithinDeadline / opened; `callbacksDelivered` (coordinator `delivered` flag); `consumerDeliveredCounterDelta` (the consumer's own count of authenticated callbacks); `callbackFailures`; `refunded`; `expiredUnfulfilled`; `skippedMemberEvents` (`FulfillmentSkipped` for this run's IDs); `aborted`.

**`summary.latencySeconds`** and **`summary.latencyBlocks`**: completion latency per request, as fulfillment block timestamp minus request block timestamp, and fulfillment block number minus request block number. Arc block timestamps have 1-second resolution, and Arc produced about two blocks per second during these runs, so block counts are the finer measure. Percentiles use the nearest-rank method (the smallest value with at least p% of observations at or below it); with 20 samples p95 is the 19th value and p99 equals the maximum.

**`summary.wallClockSeconds`**: from the start of the broadcast to the moment this process first saw the receipt, and first saw the `RandomnessFulfilled` log, by polling `eth_getLogs` every 500 ms through the read RPC. It includes RPC propagation and polling delay. `environment.localClockMinusChainSecondsAtStart` shows the offset between the local clock and chain time.

**`summary.batching`**: number of fulfillment transactions that served this run's requests, `membersPerTransaction` in block order (served plus skipped members, including other consumers' requests if the keeper mixed them in), `otherConsumersServedInTheseTransactions`, `secondsBetweenFulfillmentTransactions` and the submitting addresses.

**`summary.throughput`**: this run's fulfilled requests divided by the seconds between the first and last fulfillment block timestamps. Only burst scenarios measure the keeper's serving rate, because every request is open at the start; in the sequential and sustained scenarios the rate is limited by arrivals and is labelled so in `limitedBy`. Because the first fulfillment transaction is counted in the numerator but starts the window, the figure is slightly optimistic for short windows; `fulfillmentTransactions` and `activeWindowSeconds` are reported next to it.

**`summary.duration`**: `wallClockSeconds` from the first broadcast until settlement was observed, and `chainSeconds` from the first request block to the last fulfillment block.

**`summary.gas`**: request gas per request (transaction `gasUsed` / requests in it; this includes the consumer's own loop and storage, so the one-request-per-transaction value of `sequential-20` is the closest to a single application request), effective gas prices, fulfillment `gasUsed` per transaction and per served member (per transaction and pooled).

**`summary.costUsdc`**: `user` fee per request (`feePaid` from `RandomnessRequested`), request gas per request and their total; `keeper` fulfillment gas per served request, keeper fee share per request (`KeeperFeePaid`) and net; `run` totals and the wallet balance before and after.

**`summary.epochs`**: epoch IDs used and how many requests waited for their epoch packet to be published (`targetBlock` later than `requestBlock`). The keeper publishes an epoch packet (every 200 blocks) only when paid demand arrives, so the first request in an idle epoch includes a publication transaction.

**`summary.blocks`**: Arc block conditions from the chain head at the start of the run to the last block with a request or fulfillment of the run: block count, span, mean block interval (span / (blocks − 1)), median blocks per timestamp second, base fee min/median/max in gwei, gas used ratio mean/median/max, block gas limit and transaction counts.

**`environment`**: chain ID, read RPC and broadcast endpoints, coordinator proxy, coordinator implementation read from the ERC-1967 slot at the start and end (and whether it matches the manifest), manifest SHA-256, live pricing and keeper share, the operator-declared keeper hardware and settings, consumer address and code hash, sender, SDK/ethers/solc/Node versions and OS, and this repository's commit with a `dirty` flag for uncommitted changes outside `results/`.

The file also lists every request transaction (nonce, broadcast timing, endpoint, block, gas), every fulfillment transaction that served the run (members, gas, price, cost, keeper fees, block gas ratio), epoch publications near the run and a record per request (request and fulfillment transaction, blocks, timestamps, deadline, epoch, target block, latency, delivery, refunds and wall-clock observations).

## Keeper under test

Operator-declared, not verifiable from this repository: Hetzner vServer, AMD EPYC-Rome, 4 vCPU, 7.6 GiB RAM, 75 GB disk, Ubuntu 24.04.4 LTS, Docker 29.8.1, keeper image built from commit `d15b4a0` of the private keeper repository. Settings: `POLL_MS=250`, `TICK_TIMEOUT_SECONDS=20`, `FULFILL_BATCH_MAX=16`, `MAX_GAS=6000000`, `MAX_FEE_PER_GAS_WEI` 100 gwei, `FEE_COVERAGE_BPS=10000`, the three public RPC endpoints in `config/arc-testnet.json`, and one nonce lane (one fulfillment transaction at a time). The fulfillment submitter address is recorded in every result and should match `keeper` in the manifest.

## Limitations

- **One keeper, one testnet.** A single keeper process with one transaction lane served every request. Results do not describe Arc Mainnet, other hardware or other keeper settings.
- **Shared service.** The testnet keeper also serves other applications. Their requests can share fulfillment transactions (reported in `otherConsumersServedInTheseTransactions`) and change timing.
- **Public RPC.** Both the benchmark and the keeper use public Arc endpoints with unknown load and rate limits. Wall-clock values also include the benchmark machine's network path.
- **Chain time resolution.** Block timestamps are whole seconds; latencies in seconds carry up to one second of rounding in each direction.
- **Consumer shape.** Requests are raw words with 100,000 callback gas and a small storage-writing callback. Mapped requests, other callback gas limits or heavier callbacks change gas and fees.
- **Small samples.** Tail percentiles of 20 to 225 samples from single runs are indicative, not statistically stable. Run the suite again to compare.
- **Not an SLA.** The protocol guarantees only that a request not fulfilled within 60 seconds becomes refundable. These numbers are observations, not commitments.

## Published runs

Filled in from `results/summary.json` after the runs.

## License

MIT
