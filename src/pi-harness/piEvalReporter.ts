import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Reporter, TestCase, TestModule } from "vitest/node";

import {
  PI_EVAL_META_KEY,
  renderPiEvalReportHtml,
  type PiEvalRunRecord,
  type PiEvalShard,
  type PiEvalTestReport,
} from "./piEvalReport.ts";
import { getEvalShardModel } from "./piHarnessModels.ts";

const DEFAULT_OUTPUT = ".eval-results/index.html";
const SHARD_DIR_NAME = "shards";

function modelSlug(model: string): string {
  return model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function toTestReport(testCase: TestCase, rootDir: string): PiEvalTestReport {
  const result = testCase.result();
  const meta = testCase.meta() as Record<string, unknown>;
  const runs = (meta[PI_EVAL_META_KEY] as PiEvalRunRecord[] | undefined) ?? [];

  const state: PiEvalTestReport["state"] =
    result.state === "passed" || result.state === "failed" || result.state === "skipped"
      ? result.state
      : "pending";

  return {
    name: testCase.fullName,
    module: relative(rootDir, testCase.module.moduleId),
    state,
    durationMs: testCase.diagnostic()?.duration ?? 0,
    errors: (result.state === "failed" ? (result.errors ?? []) : []).map(
      (error) => error.stack ?? error.message ?? String(error),
    ),
    runs,
  };
}

/**
 * Writes this process's results as a per-model shard, then re-renders the
 * merged HTML report from every shard on disk.
 *
 * Rendering from shards rather than in-memory state is what lets the matrix
 * runner use one vitest process per model: each process contributes its shard
 * and the report grows, so the report is complete and correct after every run —
 * including a bare `vitest run`, and including runs where evals fail.
 */
export class PiEvalHtmlReporter implements Reporter {
  private readonly outputPath: string;
  private readonly shardDir: string;
  private rootDir = process.cwd();

  constructor(options: { outputFile?: string } = {}) {
    this.outputPath = resolve(process.cwd(), options.outputFile ?? DEFAULT_OUTPUT);
    this.shardDir = join(dirname(this.outputPath), SHARD_DIR_NAME);
  }

  onInit(vitest: { config: { root: string } }): void {
    this.rootDir = vitest.config.root;
  }

  private async readShards(): Promise<PiEvalShard[]> {
    let entries: string[];
    try {
      entries = await readdir(this.shardDir);
    } catch {
      return [];
    }

    const shards: PiEvalShard[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const raw = await readFile(join(this.shardDir, entry), "utf8");
      shards.push(JSON.parse(raw) as PiEvalShard);
    }
    return shards.sort((a, b) => a.model.localeCompare(b.model));
  }

  async onTestRunEnd(testModules: ReadonlyArray<TestModule>): Promise<void> {
    const reports: PiEvalTestReport[] = [];
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        reports.push(toTestReport(testCase, this.rootDir));
      }
    }

    // Fall back to the model the runs actually used when no shard was pinned,
    // so a bare `vitest run` still lands under the right column.
    const model =
      getEvalShardModel() ?? reports.flatMap((report) => report.runs)[0]?.model ?? "unknown";

    const shard: PiEvalShard = {
      model,
      generatedAt: new Date().toISOString(),
      reports,
    };

    await mkdir(this.shardDir, { recursive: true });
    await writeFile(
      join(this.shardDir, `${modelSlug(model)}.json`),
      JSON.stringify(shard, null, 2),
    );

    await writeFile(this.outputPath, renderPiEvalReportHtml(await this.readShards()));
    console.log(`\n  pi eval report → ${this.outputPath}\n`);
  }
}

export default PiEvalHtmlReporter;
