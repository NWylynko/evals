/**
 * Connection + model settings shared by every eval run.
 *
 * The endpoint is an LM Studio server speaking the OpenAI spec, set by
 * PI_EVAL_BASE_URL (see .env.schema). varlock fails loudly at load if it is
 * missing.
 */

import "varlock/auto-load";
import { ENV } from "varlock/env";

export const PI_EVAL_BASE_URL = ENV.PI_EVAL_BASE_URL;

/**
 * Provider id registered in each run's throwaway models.json. Deliberately
 * distinct from any provider in the developer's real ~/.pi/agent config so a
 * stray env var can never make an eval talk to the wrong endpoint.
 */
export const PI_EVAL_PROVIDER_ID = "eval-local";

/**
 * LM Studio ignores the key, but pi hides models from providers with no
 * credential at all, so a placeholder is required.
 */
export const PI_EVAL_API_KEY = "lm-studio-ignores-this";

/**
 * A model id as served by /v1/models. The matrix is discovered at runtime —
 * see piHarnessModels.ts — so this is deliberately just a string.
 */
export type EvalModel = string;

/**
 * LM Studio does not accept the `developer` role pi uses for reasoning models,
 * and does not implement `reasoning_effort`. Both must be turned off or the
 * server rejects the request.
 */
export const PI_EVAL_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
} as const;
