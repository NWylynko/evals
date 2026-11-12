import { defineConfig } from "vitest/config";

import { PiEvalHtmlReporter } from "./src/pi-harness/piEvalReporter.ts";

export default defineConfig({
  test: {
    include: ["src/**/*.eval.test.ts"],
    // A pi run boots a model on the LM Studio host and then drives a full
    // agent loop, so evals are minutes-scale, not milliseconds-scale.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Local inference serves one request at a time; parallel evals would just
    // queue on the server and blow the per-test timeout.
    fileParallelism: false,
    maxConcurrency: 1,
    reporters: ["verbose", new PiEvalHtmlReporter()],
  },
});
