// Shared helpers: configuration, signer, providers, raw JSON-RPC broadcast, retries and statistics.
// Inputs are public only: the npm SDK, the public deployment manifest and public Arc RPC endpoints.
import {readFileSync, existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {JsonRpcProvider, Network, Wallet, formatUnits, keccak256} from "ethers";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const toUsdc = (wei) => Number(formatUnits(wei, 18));
export const toGwei = (wei) => Number(wei) / 1e9;
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export function loadConfig() {
  return readJson("config/arc-testnet.json");
}

/** The signer key is read from BENCH_PRIVATE_KEY_FILE (preferred) or BENCH_PRIVATE_KEY. It is never logged. */
export function loadWallet(provider) {
  let key = process.env.BENCH_PRIVATE_KEY;
  if (process.env.BENCH_PRIVATE_KEY_FILE) key = readFileSync(process.env.BENCH_PRIVATE_KEY_FILE, "utf8").trim();
  if (!key) throw new Error("Set BENCH_PRIVATE_KEY_FILE (path to a file holding a testnet-only private key) or BENCH_PRIVATE_KEY");
  return new Wallet(key.startsWith("0x") ? key : `0x${key}`, provider);
}

export function makeProvider(url, chainId) {
  return new JsonRpcProvider(url, Network.from(chainId), {staticNetwork: true, batchMaxCount: 1});
}

/** Retries transient RPC failures (rate limits, timeouts, load-balancer hiccups) with linear backoff. */
export async function withRetry(label, fn, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(300 * attempt);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.shortMessage ?? lastError?.message ?? lastError}`);
}

/** Runs fn over items with at most `limit` concurrent calls, preserving order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

export async function rawRpc(url, method, params, timeoutMs = 10_000) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {error: {message: `HTTP ${response.status}: ${text.slice(0, 80)}`}};
  }
}

/**
 * Broadcasts a signed transaction, primary endpoint first and then the others. "already known" and similar answers
 * mean an earlier attempt reached the mempool. Returns timing and the endpoint that accepted it.
 */
export async function broadcastRaw(raw, rpcUrls, maxAttempts = 6) {
  const startedAtMs = Date.now();
  const errors = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = rpcUrls[attempt % rpcUrls.length];
    try {
      const result = await rawRpc(url, "eth_sendRawTransaction", [raw]);
      if (!result.error || /already known|known transaction|already imported/i.test(result.error.message)) {
        return {ok: true, startedAtMs, acceptedAtMs: Date.now(), acceptedBy: url, attempts: attempt + 1, errors};
      }
      errors.push(`${new URL(url).host}: ${result.error.message}`.slice(0, 160));
      if (/nonce too low|insufficient funds|intrinsic gas|exceeds block gas limit/i.test(result.error.message)) break;
    } catch (error) {
      errors.push(`${new URL(url).host}: ${error.message}`.slice(0, 160));
    }
    await sleep(200 * (attempt + 1));
  }
  return {ok: false, startedAtMs, acceptedAtMs: null, acceptedBy: null, attempts: errors.length, errors};
}

export async function waitForReceipt(provider, hash, timeoutMs = 90_000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return {receipt, observedAtMs: Date.now()};
    } catch {
      // transient RPC error: keep polling until the timeout
    }
    await sleep(intervalMs);
  }
  return {receipt: null, observedAtMs: null};
}

export async function fetchManifest(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error(`manifest ${url}: HTTP ${response.status}`);
  const text = await response.text();
  return {json: JSON.parse(text), sha256: sha256(text)};
}

export async function readImplementation(provider, proxy, blockTag = "latest") {
  const word = await withRetry("implementation slot", () => provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT, blockTag));
  return `0x${word.slice(26)}`;
}

/** Installed version of a direct dependency (read from node_modules, not from package.json ranges). */
export function packageVersion(name) {
  const file = path.join(ROOT, "node_modules", name, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : null;
}

/** Commit of this repository and whether files outside results/ differ from it. */
export function gitState() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: ROOT, encoding: "utf8"}).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {cwd: ROOT, encoding: "utf8"})
      .split(/\r?\n/).filter(Boolean).filter((line) => !line.slice(3).startsWith("results/"));
    return {commit, dirty: status.length > 0, dirtyFiles: status.map((line) => line.slice(3))};
  } catch {
    return {commit: null, dirty: null, dirtyFiles: []};
  }
}

export const runTagFor = (runId) => keccak256(Buffer.from(runId, "utf8"));

// ---- statistics -------------------------------------------------------------------------------------------------

/** Nearest-rank percentile: the smallest value with at least p% of observations at or below it. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
export const round = (value, digits = 3) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

export function distribution(values, digits = 3) {
  if (!values.length) return {count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null};
  return {
    count: values.length,
    min: round(Math.min(...values), digits),
    p50: round(percentile(values, 50), digits),
    p95: round(percentile(values, 95), digits),
    p99: round(percentile(values, 99), digits),
    max: round(Math.max(...values), digits),
    mean: round(mean(values), digits),
  };
}
