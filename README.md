# D20DAO VRF benchmarks

Reproducible load tests for the [D20DAO](https://d20dao.org) verifiable randomness service on **Arc Testnet** (chain 5042002). A small consumer contract opens paid requests against the public coordinator proxy, and a Node script records how the keeper serves them: completion latency in chain time and wall-clock time, success within the 60-second deadline, fulfillment batch sizes, throughput, gas, USDC cost and Arc block conditions during the run.

Everything here uses public inputs only: the npm package [`@d20dao/vrf-sdk`](https://www.npmjs.com/package/@d20dao/vrf-sdk) 0.4.0 (coordinator ABI and `quoteRequestFee`), the public deployment manifest <https://d20dao.org/deployments/arc-testnet.json> and public Arc RPC endpoints. Every result can be checked on [Arcscan](https://testnet.arcscan.app) from the transaction hashes in the result files.

Results are measurements of the testnet keeper fleet (a primary keeper and a backup keeper) at one point in time. They are **not an SLA** and not a mainnet capacity claim; see [Limitations](#limitations).

## Results

See [Published runs](#published-runs) below and `results/summary.json`. Each scenario has one full result file in `results/`. The earlier one-keeper runs of 2026-09-17 are kept in `results/2026-09-17-single-keeper/`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `contracts/LoadConsumer.sol` | MIT load consumer (Solidity 0.8.28, `evmVersion` cancun). Extends the SDK's `D20VRFConsumer`; `open(count, callbackGasLimit, runTag)` opens up to 100 paid raw requests in one transaction, pays the exact in-transaction `quoteFee` for each, returns unused value and records every authenticated callback in `deliveredBlock(requestId)`. The owner (benchmark wallet) is the refund address. |
| `artifacts/LoadConsumer.json` | solc-js 0.8.28 output (optimizer 200 runs) with source SHA-256s and immutable references. |
| `deployments/arc-testnet.json` | The deployed consumer, its deployment transaction and runtime code hash. |
| `config/arc-testnet.json` | Chain ID, manifest URL, coordinator proxy, read and broadcast RPC endpoints, callback gas (100,000), fee buffer and safety caps. |
| `config/scenarios.json` | Scenario definitions. |
| `config/keeper-arc-testnet.json` | Keeper hardware and settings **as declared by the operator** (not measurable from chain data). |
| `scripts/compile.mjs` | Compiles the contract (`--check` verifies the committed artifact). |
| `scripts/deploy.mjs` | Deploys the consumer and verifies its runtime code byte for byte. |
| `scripts/bench.mjs` | Runs one scenario and writes `results/<scenario>-<UTC time>.json`. |
| `scripts/suite.mjs` | Runs the four standard scenarios with a pause between them and stops on refunds, expiries or errors. `burst-500` and `burst-300-primary-stopped` run on their own with `npm run bench`. |
| `scripts/summary.mjs` | Writes `results/summary.json` (newest run per scenario, with each source file's SHA-256) and prints a table. |

## Scenarios

| Name | Load | Why |
| --- | --- | --- |
| `sequential-20` | 20 requests, one per transaction; the next is sent after the previous one is fulfilled (or its deadline passes). | Baseline latency for an isolated request. |
| `burst-50` | 50 requests in one transaction, so all 50 share one block. | Batching behaviour for a burst that needs several 16-member fulfillments. |
| `burst-200` | 200 requests in four 50-request transactions broadcast together (about 11M gas each, so at least two 30M-gas blocks). | Queueing under a large simultaneous burst; the keeper's sustained serving rate when every request is already open. |
| `sustained-5rps-40s` | One 5-request transaction every second for 40 seconds (200 requests). | Steady arrivals below the burst serving rate. 40 s instead of 60 s keeps the suite, including one repeated baseline run, under 500 paid requests. |
| `burst-500` | 500 requests in ten 50-request transactions broadcast together. | The serving rate of the primary and backup keeper together; the backup joins when the queue is deep. |
| `burst-300-primary-stopped` | 300 requests in six 50-request transactions; the operator stops the primary keeper a few seconds in. | Takeover: the backup keeper finishes the queue alone. The stop is an operator action outside the script and is recorded under Published runs. |

Why a contract: Arc Testnet keeps only about 16 pending transactions per sender, and the coordinator accepts requests only from contracts. Opening many requests per transaction is the only way for one wallet to create concurrent load.

## Reproduce

Requirements: Node 22.13 or newer (the SDK's minimum), npm, and an Arc Testnet wallet holding test USDC. The native gas token on Arc is USDC with 18 decimals; test USDC comes from the faucet linked in Arc's [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc) reference.

1. **Install and compile**

   ```sh
   npm ci
   npm run compile -- --check   # or npm run compile to rebuild the artifact
   ```

2. **Fund a dedicated testnet wallet.** Use a fresh key that holds nothing else. At the initialized pricing (0.08 USDC minimum fee per request, 100,000 callback gas, base fee near 20 gwei) the suite of 470 requests costs about 40 USDC: 37.6 USDC in request fees plus about 2 USDC of request gas. Put the key in a file outside the repository (`*.key` is git-ignored anyway):

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

**`summary.wallClockSeconds`**: from the start of the broadcast to the moment this process first saw the receipt, and first saw the `RandomnessFulfilled` log, by polling `eth_blockNumber` and `eth_getLogs` every 500 ms through the read RPC. It includes RPC propagation and polling delay. `environment.watcher` records polls, failed polls and the longest gap between successful polls, so an observation stall is visible next to the numbers it affects. `environment.localClockMinusChainSecondsAtStart` shows the offset between the local clock and chain time.

**`summary.batching`**: number of fulfillment transactions that served this run's requests, `membersPerTransaction` in block order (served plus skipped members, including other consumers' requests if the keeper mixed them in), `otherConsumersServedInTheseTransactions`, `secondsBetweenFulfillmentTransactions` and the submitting addresses.

**`summary.throughput`**: this run's fulfilled requests divided by the seconds between the first and last fulfillment block timestamps. Only burst scenarios measure the keeper's serving rate, because every request is open at the start; in the sequential and sustained scenarios the rate is limited by arrivals and is labelled so in `limitedBy`. Because the first fulfillment transaction is counted in the numerator but starts the window, the figure is slightly optimistic for short windows; `fulfillmentTransactions` and `activeWindowSeconds` are reported next to it.

**`summary.duration`**: `wallClockSeconds` from the first broadcast until settlement was observed, and `chainSeconds` from the first request block to the last fulfillment block.

**`summary.gas`**: request gas per request (transaction `gasUsed` / requests in it; this includes the consumer's own loop and storage, so the one-request-per-transaction value of `sequential-20` is the closest to a single application request), effective gas prices, fulfillment `gasUsed` per transaction and per served member (per transaction and pooled).

**`summary.costUsdc`**: `user` fee per request (`feePaid` from `RandomnessRequested`), request gas per request and their total; `keeper` fulfillment gas per served request, keeper fee share per request (`KeeperFeePaid`) and net; `run` totals and the wallet balance before and after.

**`summary.epochs`**: epoch IDs used and how many requests waited for their epoch packet to be published (`targetBlock` later than `requestBlock`). The keeper publishes an epoch packet (every 200 blocks) only when paid demand arrives, so the first request in an idle epoch includes a publication transaction.

**`summary.blocks`**: Arc block conditions from the chain head at the start of the run to the last block with a request or fulfillment of the run: block count, span, mean block interval (span / (blocks − 1)), median blocks per timestamp second, base fee min/median/max in gwei, gas used ratio mean/median/max, block gas limit and transaction counts.

**`environment`**: chain ID, read RPC and broadcast endpoints, coordinator proxy, coordinator implementation read from the ERC-1967 slot at the start and end (and whether it matches the manifest), manifest SHA-256, live pricing and keeper share, the operator-declared keeper hardware and settings, consumer address and code hash, sender, SDK/ethers/solc/Node versions and OS, and this repository's commit with a `dirty` flag for uncommitted changes outside `results/`.

The file also lists every request transaction (nonce, broadcast timing, endpoint, block, gas), every fulfillment transaction that served the run (members, gas, price, cost, keeper fees, block gas ratio), epoch publications near the run and a record per request (request and fulfillment transaction, blocks, timestamps, deadline, epoch, target block, latency, delivery, refunds and wall-clock observations).

## Observation endpoint

Reads, receipt polling and the fulfillment watcher use `https://rpc.blockdaemon.testnet.arc.io` (`readRpcUrl`); request transactions are broadcast there first and then to the other two public endpoints. During the first attempt of this suite, `https://rpc.testnet.arc.io` answered `HTTP 429 rate limit exceeded` at roughly five requests per second. ethers retries 429 responses internally without surfacing them, so the benchmark's own receipt and log polling stalled for up to about 50 seconds while chain data showed every request fulfilled within 5 seconds. That run is kept in `results/superseded/` and is not part of the summary. The watcher now uses plain JSON-RPC calls with a 3-second timeout and records its own stalls.

## Keeper under test

Operator-declared, not verifiable from this repository (`config/keeper-arc-testnet.json`): two keepers built from commit `5af598e` of the private keeper repository, image `ghcr.io/d20dao/keeper@sha256:ceeae71a2692f2fa89200457ce1c251d59f377f6f258a1e251195ce972675343`, each with its own wallet and one nonce lane (one fulfillment transaction at a time).

- **Primary** (`0x61659d9A9A85dA07C36e7d1B35CF0d96CF199Cac`, the manifest keeper): x86-64 virtual server (KVM), AMD EPYC-Genoa, 4 vCPU, 7.8 GiB RAM, Debian 13, Docker 29.8.1.
- **Backup** (`0xbb2fdE97a5F4855bEf872C71fbb80Be3170127Ee`, authorized on chain as a backup committer): 2 vCPU, 3.8 GiB RAM, otherwise the same. It prepares and serves from the newest end of the queue when the oldest open request is older than 20 s, the open queue exceeds 150 requests, or the primary stops making progress.
- **Settings:** `POLL_MS=250` while work is open, `IDLE_POLL_MS=1000`, `TICK_TIMEOUT_SECONDS=20`, `FULFILL_BATCH_MAX=16`, `MAX_GAS=6000000`, `MAX_FEE_PER_GAS_WEI` 100 gwei, `FEE_COVERAGE_BPS=10000`. New blocks and service events arrive over one public WebSocket endpoint; every decision is read over HTTP from the public endpoints in `config/keeper-arc-testnet.json`.

The submitter of every fulfillment transaction is recorded from chain data in each result (`batching.bySubmitter`).

## Limitations

- **Two keepers, one testnet.** A primary and a backup keeper, each with one transaction lane, served the requests. Results do not describe Arc Mainnet, other hardware or other keeper settings.
- **Shared service.** The testnet keeper also serves other applications. Their requests can share fulfillment transactions (reported in `otherConsumersServedInTheseTransactions`) and change timing.
- **Public RPC.** Both the benchmark and the keeper use public Arc endpoints with unknown load and rate limits. Wall-clock values also include the benchmark machine's network path.
- **Chain time resolution.** Block timestamps are whole seconds; latencies in seconds carry up to one second of rounding in each direction.
- **Consumer shape.** Requests are raw words with 100,000 callback gas and a small storage-writing callback. Mapped requests, other callback gas limits or heavier callbacks change gas and fees.
- **Small samples.** Tail percentiles of 20 to 500 samples from single runs are indicative, not statistically stable. Run the suite again to compare.
- **Not an SLA.** The protocol guarantees only that a request not fulfilled within 60 seconds becomes refundable. These numbers are observations, not commitments.

## Published runs

Six scenarios on 2026-09-18 between 12:17 and 12:32 UTC, all from script commit `5df5f5b695f8528af1d0fffe674446d54e7f5725` with a clean working tree, against coordinator implementation `0xd20da0dada4352a1a9722be43a2d85923443458c` (matched the manifest before and after every run). LoadConsumer: [`0xd23C36e40444e8E90f1213F23F391C5b1135215f`](https://testnet.arcscan.app/address/0xd23C36e40444e8E90f1213F23F391C5b1135215f). Every fulfillment came from the primary or the backup keeper; no other application's request shared these fulfillment transactions. The Arc Testnet base fee stayed at 20 gwei and blocks arrived about every 0.5 s. The runner used Node 24.19.0, ethers 6.17.0 and `@d20dao/vrf-sdk` 0.4.0. In `burst-300-primary-stopped` the requests were signed at 12:19:25 UTC and the primary keeper was stopped at 12:19:38 UTC; it was started again after the run. Full numbers: `results/summary.json` and the linked files.

| Scenario | Requests | Within 60 s | Completion p50 / p95 / p99 / max | Blocks p50 / p95 / max | Fulfillment txs (members) | Served: primary / backup | Throughput | Chain duration | Gas per request: request / fulfillment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [`sequential-20`](results/sequential-20-20260918T122306Z.json) | 20 (1 per tx, 20 blocks) | 20/20 | 2 / 3 / 14 / 14 s | 4 / 6 / 29 | 20 (1 × 20) | 20 / 0 | arrival-limited (0.28/s) | 74 s | 296,966 / 301,311 |
| [`burst-50`](results/burst-50-20260918T122629Z.json) | 50 (50 per tx, 1 block) | 50/50 | 8 / 10 / 10 / 10 s | 17 / 20 / 20 | 5 (16, 14, 8 × 2, 4) | 50 / 0 | 7.14/s over 7 s | 10 s | 195,898 / 262,921 |
| [`burst-200`](results/burst-200-20260918T122846Z.json) | 200 (50 per tx, 2 blocks) | 200/200 | 10 / 14 / 15 / 15 s | 20 / 28 / 30 | 19 (16 × 9, 8 × 7, 4 × 3) | 140 / 60 | 16.67/s over 12 s | 16 s | 195,594 / 265,183 |
| [`sustained-5rps-40s`](results/sustained-5rps-40s-20260918T123110Z.json) | 200 (5 per tx, 40 blocks) | 200/200 | 5 / 8 / 9 / 9 s | 9 / 16 / 19 | 22 (16 × 4, 15, 13, 11, 10 × 4, 9, 8, 7, 5 × 5, 4, 2 × 2) | 200 / 0 | arrival-limited (5.13/s) | 42 s | 230,275 / 237,741 |
| [`burst-500`](results/burst-500-20260918T121745Z.json) | 500 (50 per tx, 5 blocks) | 500/500 | 18 / 25 / 27 / 27 s | 35 / 49 / 53 | 35 (16 × 29, 8 × 3, 4 × 3) | 292 / 208 | 22.73/s over 22 s | 27 s | 203,648 / 250,924 |
| [`burst-300-primary-stopped`](results/burst-300-primary-stopped-20260918T121924Z.json) | 300 (50 per tx, 4 blocks) | 300/300 | 8 / 17 / 17 / 18 s | 16 / 34 / 36 | 22 (16 × 17, 11, 8, 6, 2, 1) | 184 / 116 | 21.43/s over 14 s | 18 s | 205,704 / 253,930 |

Observations:

- **Serving rate.** With every request already open, the two keepers served 22.73 requests per second over 22 s in `burst-500` and 16.67 per second in `burst-200`. Batches reached the cap of 16 members (`FULFILL_BATCH_MAX`, the coordinator's `MAX_FULFILL_BATCH`). In `burst-500` and `burst-300-primary-stopped` no transaction repeated a request the other keeper had served. In `burst-200` the two keepers met at the end of the queue twice: one primary transaction (8 members) and one backup transaction (4 members) found every member already served, and the coordinator skipped them (`FulfillmentSkipped`, reason 1) at the cost of those two transactions' gas.
- **Takeover.** In `burst-300-primary-stopped` the primary had served 184 requests when it was stopped; the backup served the other 116, and the last request completed 18 s after its request block.
- **Queueing.** Completion in a burst grows with queue position: the last of 500 simultaneous requests completed 27 s after its request block, within the 60 s deadline. At 5 requests per second completion stayed at 9 s or less, served by the primary alone.
- **Isolated requests** completed in a median of 2 chain seconds (4 blocks). One request of `sequential-20` (id 4708) arrived two blocks into epoch 1458, whose selected source returned no packet; the next source was published when the protocol's fallback window opened 20 blocks into the epoch, and the request completed in 14 s.
- **Cost.** Every request paid the 0.08 USDC minimum fee. Request gas through LoadConsumer was 296,966 for a single request and about 195,600 per request in a 50-request transaction (0.0074 and 0.0049 USDC). The keeper's share was 0.04 USDC per request against 0.0064 to 0.0097 USDC of fulfillment gas per served request.

`results/2026-09-17-single-keeper/` holds the previous published runs: the same four standard scenarios served by one keeper, before the 2026-09-18 contract and keeper upgrades. `results/superseded/` holds an earlier `sequential-20` run whose wall-clock observations were distorted by RPC rate limiting (see [Observation endpoint](#observation-endpoint)). Two 3-request pipeline checks (`smoke`) are not published.

## License

MIT
