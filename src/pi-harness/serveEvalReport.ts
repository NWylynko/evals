/**
 * Serves the generated eval report on a local port.
 *
 * `pnpm eval` rewrites .eval-results/index.html in place, so this serves the
 * directory from disk on every request with caching disabled — leave the tab
 * open, run the matrix, refresh, and you see the new report.
 */

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

const RESULTS_DIR = resolve(process.cwd(), ".eval-results");
const REPORT_FILE = join(RESULTS_DIR, "index.html");
const PORT = Number(process.env.PORT ?? 4321);

try {
  await access(REPORT_FILE);
} catch {
  console.error(
    `No eval report found at ${REPORT_FILE}.\n` +
      `Run \`pnpm eval\` first (or \`PI_EVAL_MODELS=google/gemma-4-e4b pnpm eval\` for a quick one).`,
  );
  process.exit(1);
}

const app = Fastify({ logger: false });

// The report is regenerated between refreshes; a cached copy is always wrong.
app.addHook("onSend", async (_request, reply) => {
  reply.header("cache-control", "no-store");
});

await app.register(fastifyStatic, {
  root: RESULTS_DIR,
  index: ["index.html"],
  cacheControl: false,
});

// The shard JSON is served too, for poking at raw results.
const address = await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`\n  pi eval report → ${address}\n  (ctrl-c to stop)\n`);
