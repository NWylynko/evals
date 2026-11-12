/**
 * Model discovery.
 *
 * The matrix is whatever the server currently serves — nothing is hardcoded.
 * During framework development, pin it to one or two fast models with
 * PI_EVAL_MODELS so a change doesn't cost a full matrix run.
 *
 * Discovery uses LM Studio's own /api/v1/models rather than the OpenAI-spec
 * /v1/models, which returns ids and nothing else. The native endpoint reports
 * model type and per-model capabilities (tool use, vision, reasoning), so the
 * harness can tell pi what each model actually is instead of assuming.
 *
 * This does couple discovery to LM Studio. The eval traffic itself stays pure
 * OpenAI spec — only the catalog lookup is vendor-specific.
 */

import { PI_EVAL_BASE_URL } from "./piHarnessConfig.ts";

/** Set by the matrix runner to pin one vitest process to a single model. */
export const PI_EVAL_SHARD_ENV = "PI_EVAL_MODEL";

/** Comma-separated dev override for the whole matrix. */
export const PI_EVAL_MATRIX_ENV = "PI_EVAL_MODELS";

export interface EvalModelInfo {
  id: string;
  /** "llm" for chat models, "embedding" for embedding models. */
  type: string;
  displayName: string;
  paramsString: string | undefined;
  maxContextLength: number | undefined;
  supportsTools: boolean;
  supportsVision: boolean;
  /** True when the model does extended thinking. */
  supportsReasoning: boolean;
  /** False for models whose reasoning cannot be switched off. */
  reasoningCanBeDisabled: boolean;
}

interface LmStudioModel {
  key?: string;
  type?: string;
  display_name?: string;
  params_string?: string;
  max_context_length?: number;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: boolean | { allowed_options?: string[]; default?: string };
  };
}

/** LM Studio's native API sits next to the OpenAI-compatible one. */
function lmStudioCatalogUrl(): string {
  return `${new URL(PI_EVAL_BASE_URL).origin}/api/v1/models`;
}

let catalogPromise: Promise<EvalModelInfo[]> | undefined;

function toModelInfo(entry: LmStudioModel): EvalModelInfo | undefined {
  if (!entry.key) return undefined;
  const capabilities = entry.capabilities ?? {};
  const reasoning = capabilities.reasoning;
  const allowedOptions =
    typeof reasoning === "object" ? (reasoning.allowed_options ?? []) : reasoning ? ["on"] : [];

  return {
    id: entry.key,
    type: entry.type ?? "unknown",
    displayName: entry.display_name ?? entry.key,
    paramsString: entry.params_string,
    maxContextLength: entry.max_context_length,
    supportsTools: capabilities.trained_for_tool_use === true,
    supportsVision: capabilities.vision === true,
    supportsReasoning: allowedOptions.length > 0,
    reasoningCanBeDisabled: allowedOptions.includes("off"),
  };
}

async function requestCatalog(): Promise<EvalModelInfo[]> {
  const catalogUrl = lmStudioCatalogUrl();
  let payload: { models?: LmStudioModel[] };

  try {
    const response = await fetch(catalogUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    payload = (await response.json()) as { models?: LmStudioModel[] };
  } catch (error) {
    throw new Error(
      `pi eval harness: cannot read the model catalog at ${catalogUrl}. ` +
        `This endpoint is LM Studio's native API — is LM Studio running and reachable? ` +
        `Cause: ${(error as Error).message}`,
    );
  }

  const models = (payload.models ?? [])
    .map(toModelInfo)
    .filter((info): info is EvalModelInfo => info !== undefined);

  if (models.length === 0) {
    throw new Error(`pi eval harness: ${catalogUrl} returned no models.`);
  }
  return models;
}

/** Full catalog, including embedding models. Fetched once per process. */
export async function fetchModelCatalog(): Promise<EvalModelInfo[]> {
  catalogPromise ??= requestCatalog();
  return catalogPromise;
}

/**
 * Models an agent eval can actually use: chat models trained for tool use.
 * Embedding models cannot hold a conversation, and a model with no tool
 * training cannot do the work these evals ask for.
 */
export async function fetchServedModels(): Promise<string[]> {
  const catalog = await fetchModelCatalog();
  return catalog
    .filter((info) => info.type !== "embedding" && info.supportsTools)
    .map((info) => info.id)
    .sort();
}

export async function getEvalModelInfo(model: string): Promise<EvalModelInfo> {
  const catalog = await fetchModelCatalog();
  const info = catalog.find((entry) => entry.id === model);
  if (!info) {
    throw new Error(
      `pi eval harness: model "${model}" is not in the catalog at ${lmStudioCatalogUrl()}.`,
    );
  }
  return info;
}

/**
 * The models this run should evaluate: the PI_EVAL_MODELS override if set,
 * otherwise every eligible model the server serves.
 *
 * An override naming a model the server does not serve is a hard error — it
 * almost always means a typo, and silently skipping it would quietly shrink
 * the matrix.
 */
export async function resolveEvalModels(): Promise<string[]> {
  const served = await fetchServedModels();
  const override = process.env[PI_EVAL_MATRIX_ENV];
  if (!override) return served;

  const requested = override
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    throw new Error(`pi eval harness: ${PI_EVAL_MATRIX_ENV} is set but empty.`);
  }

  const missing = requested.filter((model) => !served.includes(model));
  if (missing.length > 0) {
    throw new Error(
      `pi eval harness: ${PI_EVAL_MATRIX_ENV} names model(s) the server does not serve ` +
        `as tool-capable chat models: ${missing.join(", ")}.\nServed: ${served.join(", ")}`,
    );
  }
  return requested;
}

/**
 * The model this vitest process is pinned to, if the matrix runner started it.
 * Undefined when vitest is invoked directly.
 */
export function getEvalShardModel(): string | undefined {
  const model = process.env[PI_EVAL_SHARD_ENV];
  return model && model.length > 0 ? model : undefined;
}

/** Verifies a model is actually usable before pi is spawned against it. */
export async function assertEvalModelAvailable(model: string): Promise<void> {
  const served = await fetchServedModels();
  if (!served.includes(model)) {
    throw new Error(
      `pi eval harness: model "${model}" is not an available tool-capable chat model. ` +
        `Served: ${served.join(", ")}`,
    );
  }
}
