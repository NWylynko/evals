/**
 * Model residency: getting a model loaded, and finding out what context window
 * it actually got.
 *
 * Why this exists: the catalog's `max_context_length` is what a model
 * *supports*, not what the resident instance was loaded with. LM Studio loads
 * each model at whatever its own per-model config says — for
 * nvidia/nemotron-3-nano-omni that is 8192 against a 262144 ceiling. Declaring
 * the ceiling to pi makes it believe it has 32x the headroom it has, so it
 * never compacts and the run dies on a provider 400 as soon as a tool returns
 * a large result. That is indistinguishable, in a report, from the model being
 * bad at the task.
 *
 * So the harness loads the model itself and reads the context length back off
 * the resident instance. Established by experiment against the server:
 *
 * - `POST /api/v1/models/load` accepts `model`, `context_length`,
 *   `parallel`, `flash_attention`, `eval_batch_size`. It answers once the model
 *   is resident, so there is nothing to poll.
 * - **`context_length` on the request is advisory.** nemotron honours it;
 *   google/gemma-4-e4b ignores it and keeps its saved 131072. The harness
 *   therefore does not ask for one — it takes the default and reports the
 *   truth. Never trust the requested value; only the read-back.
 * - **An explicit load does not evict.** JIT loading holds one model resident,
 *   but loading through this endpoint stacks instances until the box runs out
 *   of memory (a second nemotron load failed at ~25.6 GB with two others
 *   resident). Other instances are unloaded first to keep the
 *   one-model-resident behaviour the matrix depends on.
 * - Loading the same model twice makes a *second* instance (`<id>:2`) rather
 *   than reusing the first, which is why residency is checked before loading.
 */

import { PI_EVAL_BASE_URL } from "./piHarnessConfig.ts";

/** One resident copy of a model, as the server reports it. */
export interface LmStudioInstance {
  id: string;
  config?: { context_length?: number; parallel?: number };
}

interface LmStudioCatalogEntry {
  key?: string;
  loaded_instances?: LmStudioInstance[];
}

/**
 * Evals run one at a time (`fileParallelism: false`), so a single slot gets the
 * whole KV cache instead of reserving three that nothing will use.
 */
const EVAL_PARALLEL_SLOTS = 1;

function lmStudioOrigin(): string {
  return new URL(PI_EVAL_BASE_URL).origin;
}

async function lmStudioRequest<T>(path: string, body?: unknown): Promise<T> {
  const url = `${lmStudioOrigin()}${path}`;
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    // A cold load of a 30B model is ~30s; a large one can be minutes.
    signal: AbortSignal.timeout(600_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`pi eval harness: ${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Every resident copy of `model`, straight from the server.
 *
 * Deliberately not cached: unlike the catalog, residency changes underneath us
 * — instances have a TTL, and the matrix loads and unloads as it goes.
 */
export async function readLmStudioInstances(model: string): Promise<LmStudioInstance[]> {
  const catalog = await lmStudioRequest<{ models?: LmStudioCatalogEntry[] }>("/api/v1/models");
  const entry = (catalog.models ?? []).find((candidate) => candidate.key === model);
  return entry?.loaded_instances ?? [];
}

/**
 * The context window a resident model actually has, in tokens.
 *
 * Throws rather than guessing: a wrong number here is exactly the failure this
 * module exists to prevent, and it would be invisible until a run 400s.
 */
export function loadedContextLengthOf(instances: LmStudioInstance[]): number {
  const contextLength = instances[0]?.config?.context_length;
  if (typeof contextLength !== "number" || contextLength <= 0) {
    throw new Error(
      `pi eval harness: the loaded instance reports no usable context_length ` +
        `(got ${JSON.stringify(contextLength)}). Without it the harness cannot tell pi ` +
        `how much room the model really has.`,
    );
  }
  return contextLength;
}

/** Instances of every *other* model, so they can be evicted before a load. */
async function readOtherModelInstances(model: string): Promise<LmStudioInstance[]> {
  const catalog = await lmStudioRequest<{ models?: LmStudioCatalogEntry[] }>("/api/v1/models");
  return (catalog.models ?? [])
    .filter((entry) => entry.key !== model)
    .flatMap((entry) => entry.loaded_instances ?? []);
}

/** Per-process memo: within one shard the model and its context never change. */
const residentContextWindows = new Map<string, Promise<number>>();

/**
 * Makes `model` the one resident model and returns the context window it got.
 *
 * Idempotent: an already-resident model is measured, not reloaded — reloading
 * would stack a second instance rather than replace the first.
 */
export async function ensureEvalModelLoaded(model: string): Promise<number> {
  const cached = residentContextWindows.get(model);
  if (cached) return cached;

  const pending = loadAndMeasure(model);
  residentContextWindows.set(model, pending);
  try {
    return await pending;
  } catch (error) {
    // A failed load must not poison the memo for the rest of the process.
    residentContextWindows.delete(model);
    throw error;
  }
}

async function loadAndMeasure(model: string): Promise<number> {
  const resident = await readLmStudioInstances(model);
  if (resident.length > 0) return loadedContextLengthOf(resident);

  // Explicit loads stack, so make room the way JIT loading would have.
  for (const instance of await readOtherModelInstances(model)) {
    await lmStudioRequest("/api/v1/models/unload", { instance_id: instance.id });
  }

  await lmStudioRequest("/api/v1/models/load", {
    model,
    parallel: EVAL_PARALLEL_SLOTS,
  });

  const loaded = await readLmStudioInstances(model);
  if (loaded.length === 0) {
    throw new Error(
      `pi eval harness: LM Studio reported "${model}" loaded, but it is not resident. ` +
        `Nothing can be declared to pi about its context window.`,
    );
  }
  return loadedContextLengthOf(loaded);
}
