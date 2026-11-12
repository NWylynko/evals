import { describe, expect, it } from "vitest";

import {
  PI_EVAL_PROVIDER_ID,
  createPiHarness,
  loadedContextLengthOf,
  readLmStudioInstances,
} from "../pi-harness/index.ts";

/**
 * A framework invariant, checked per model rather than once.
 *
 * The bug this exists to catch: discovery read `max_context_length` — what the
 * model *supports* — and declared it to pi as the context window. LM Studio
 * loads a model at whatever its own per-model config says, which for
 * nemotron-3-nano-omni is 8192 against a 262144 ceiling. pi therefore believed
 * it had 32x the headroom it really had, never compacted, and the run died on a
 * provider 400 the moment a tool returned a large result.
 *
 * Nothing in an eval's assertions can catch that — it surfaces as an unrelated
 * model failure. So it is asserted directly, against the server's own report of
 * the resident instance, for whichever model this shard is pinned to.
 */
describe("harness: context window", () => {
  it("declares the model's real loaded context window to pi, not its ceiling", async () => {
    const harness = await createPiHarness();

    const declared = JSON.parse(
      await harness.readConfigFile("models.json"),
    ) as PiModelsConfig;
    const model = declared.providers[PI_EVAL_PROVIDER_ID]?.models.find(
      (entry) => entry.id === harness.model,
    );

    expect(model, `models.json has no entry for ${harness.model}`).toBeDefined();

    // The server's own account of the resident instance is the only truth here:
    // the catalog's ceiling is wrong, and a requested context length is merely
    // advisory (gemma-4-e4b ignores it and keeps its saved 131072).
    const instances = await readLmStudioInstances(harness.model);
    expect(
      instances.length,
      `${harness.model} is not resident — the harness must load it before writing models.json`,
    ).toBeGreaterThan(0);

    expect(model?.contextWindow).toBe(loadedContextLengthOf(instances));
  });
});

interface PiModelsConfig {
  providers: Record<string, { models: { id: string; contextWindow?: number }[] } | undefined>;
}
