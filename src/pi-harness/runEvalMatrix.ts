/**
 * Runs the eval suite once per model, model-outer.
 *
 * The server holds one model in memory at a time, so every model switch costs a
 * full unload/load. Vitest runs test files one after another, which means a
 * model loop *inside* the tests would reload models once per file. Making the
 * model the outer loop — one vitest process per model — costs exactly one load
 * per model no matter how many eval files exist.
 *
 * Each vitest process writes its own shard and re-renders the merged report, so
 * the report is complete after the final model finishes.
 */

import { spawn } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  PI_EVAL_MATRIX_ENV,
  PI_EVAL_SHARD_ENV,
  fetchServedModels,
  resolveEvalModels,
} from "./piHarnessModels.ts";

const RESULTS_DIR = resolve(process.cwd(), ".eval-results");
const SHARD_DIR = join(RESULTS_DIR, "shards");
const VITEST_BIN = resolve(process.cwd(), "node_modules/.bin/vitest");

function runVitestForModel(model: string, extraArgs: string[]): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(VITEST_BIN, ["run", ...extraArgs], {
      stdio: "inherit",
      env: { ...process.env, [PI_EVAL_SHARD_ENV]: model },
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

const models = await resolveEvalModels();
const extraArgs = process.argv.slice(2);

console.log(`\npi eval matrix — ${models.length} model(s), one vitest run each:`);
for (const model of models) console.log(`  · ${model}`);
if (!process.env[PI_EVAL_MATRIX_ENV]) {
  console.log(
    `\nEvaluating every served model. Set ${PI_EVAL_MATRIX_ENV}=a,b to narrow this ` +
      `(each extra model costs a full load/unload on the server).`,
  );
}
console.log("");

/**
 * Drops only the shards this run will replace, plus any whose model the server
 * no longer serves.
 *
 * Wiping the whole directory instead would mean a narrowed `PI_EVAL_MODELS` run
 * — the normal way to iterate — silently destroys the full matrix report.
 * Scoping it this way lets a one-model run refresh one column and leave the
 * rest standing, while still preventing phantom columns for models that are
 * gone.
 */
async function pruneStaleShards(matrixModels: string[]): Promise<void> {
  const served = new Set(await fetchServedModels());
  let entries: string[];
  try {
    entries = await readdir(SHARD_DIR);
  } catch {
    return;
  }

  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const path = join(SHARD_DIR, entry);
    let model: string;
    try {
      model = (JSON.parse(await readFile(path, "utf8")) as { model: string }).model;
    } catch {
      await rm(path);
      continue;
    }

    if (matrixModels.includes(model)) {
      await rm(path);
    } else if (!served.has(model)) {
      console.log(`  dropping stale shard: ${model} (no longer served)`);
      await rm(path);
    } else {
      console.log(`  keeping earlier result: ${model}`);
    }
  }
}

await pruneStaleShards(models);

const failedModels: string[] = [];
for (const [index, model] of models.entries()) {
  console.log(`\n━━━ [${index + 1}/${models.length}] ${model} ━━━\n`);
  const exitCode = await runVitestForModel(model, extraArgs);
  if (exitCode !== 0) failedModels.push(model);
}

console.log("\n━━━ matrix complete ━━━");
if (failedModels.length > 0) {
  console.log(`failing model(s): ${failedModels.join(", ")}`);
  process.exit(1);
}
console.log(`all ${models.length} model(s) passed`);
