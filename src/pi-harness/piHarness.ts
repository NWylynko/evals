import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { onTestFinished } from "vitest";

import {
  PI_EVAL_API_KEY,
  PI_EVAL_BASE_URL,
  PI_EVAL_COMPAT,
  PI_EVAL_PROVIDER_ID,
  type EvalModel,
} from "./piHarnessConfig.ts";
import {
  PI_EVAL_SHARD_ENV,
  assertEvalModelAvailable,
  getEvalModelInfo,
  getEvalShardModel,
  resolveEvalModels,
  type EvalModelInfo,
} from "./piHarnessModels.ts";
import { ensureEvalModelLoaded } from "./piHarnessLoad.ts";
import {
  collectAssistantMessages,
  collectToolCalls,
  extractErrorMessage,
  extractFinalText,
  parsePiEventStream,
  sumPiUsage,
  type PiAssistantMessage,
  type PiEvent,
  type PiToolCall,
  type PiUsageTotals,
} from "./piEventStream.ts";
import { recordPiEvalRun, stringifyToolField, truncateForReport } from "./piEvalReport.ts";

/** Set KEEP_EVAL_TMP=1 to leave the sandbox on disk for post-mortem debugging. */
const KEEP_EVAL_TMP = process.env.KEEP_EVAL_TMP === "1";

const DEFAULT_RUN_TIMEOUT_MS = 240_000;

export interface PiHarnessOptions {
  model?: EvalModel;
  /** Files seeded into the workspace before the agent runs. Keys are relative paths. */
  files?: Record<string, string>;
  /** Replace pi's built-in coding-assistant system prompt. */
  systemPrompt?: string;
  /** Allowlist of tool names. Omit to leave pi's built-in tools enabled. */
  tools?: string[];
  /**
   * Let pi discover AGENTS.md / CLAUDE.md by walking up from the workspace.
   * Off by default so an eval only sees context it seeded itself.
   */
  contextFiles?: boolean;
}

export interface PiRunOptions {
  timeoutMs?: number;
}

export interface PiRunResult {
  exitCode: number | null;
  events: PiEvent[];
  assistantMessages: PiAssistantMessage[];
  /** Text of the final assistant message, thinking blocks excluded. */
  finalText: string;
  toolCalls: PiToolCall[];
  toolNames: string[];
  stopReason: string | undefined;
  /** Provider/model error behind a failed run. Undefined on success. */
  errorMessage: string | undefined;
  /** Token usage summed across the run's assistant messages. */
  usage: PiUsageTotals;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface PiHarness {
  /** Sandbox root; contains `config/` and `workspace/`. */
  readonly rootDir: string;
  /** Throwaway PI_CODING_AGENT_DIR for this run. */
  readonly configDir: string;
  /** cwd the agent runs in. */
  readonly workspaceDir: string;
  readonly model: EvalModel;
  runPiAgent(prompt: string, options?: PiRunOptions): Promise<PiRunResult>;
  readWorkspaceFile(relativePath: string): Promise<string>;
  /** Reads a generated pi config file — for asserting what pi was told. */
  readConfigFile(relativePath: string): Promise<string>;
  /** True when the path exists in the workspace — for asserting an agent created a file. */
  workspaceFileExists(relativePath: string): Promise<boolean>;
  writeWorkspaceFile(relativePath: string, contents: string): Promise<void>;
  cleanup(): Promise<void>;
}

let announcedDefaultModel = false;

/**
 * Which model a harness uses when the eval does not name one.
 *
 * Normally this is the model the matrix runner pinned this process to. When
 * vitest is run directly (single-file iteration, watch mode) there is no shard,
 * so the first model of the resolved matrix is used and announced — running one
 * model instead of the full matrix should never be silent.
 *
 * Resolving through the matrix (not the raw served list) keeps PI_EVAL_MODELS
 * meaningful here too: narrowing the matrix also picks the single-run model.
 */
async function resolveHarnessModel(): Promise<EvalModel> {
  const shardModel = getEvalShardModel();
  if (shardModel) return shardModel;

  const [firstModel] = await resolveEvalModels();
  if (!firstModel) {
    throw new Error(`pi eval harness: ${PI_EVAL_BASE_URL}/models serves no chat models.`);
  }
  if (!announcedDefaultModel) {
    announcedDefaultModel = true;
    console.log(
      `[pi-eval] ${PI_EVAL_SHARD_ENV} unset — using "${firstModel}". ` +
        `Run \`pnpm eval\` to evaluate the full matrix.`,
    );
  }
  return firstModel;
}

/**
 * Builds a blank pi config directory. Nothing is inherited from the developer's
 * real ~/.pi/agent — only the provider under test is registered.
 */
async function writePiConfigDir(
  configDir: string,
  info: EvalModelInfo,
  contextWindow: number,
): Promise<void> {
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          [PI_EVAL_PROVIDER_ID]: {
            baseUrl: PI_EVAL_BASE_URL,
            api: "openai-completions",
            apiKey: PI_EVAL_API_KEY,
            compat: PI_EVAL_COMPAT,
            models: [
              {
                id: info.id,
                name: info.displayName,
                // Declared from the server's own catalog rather than assumed:
                // every model here reasons by default, and describing them as
                // non-reasoning would misrepresent them to pi.
                reasoning: info.supportsReasoning,
                input: info.supportsVision ? ["text", "image"] : ["text"],
                // The *resident instance's* context, never the catalog's
                // max_context_length — see piHarnessLoad.ts. The ceiling is
                // what the model supports; this is what it was loaded with,
                // and pi compacts against this number.
                contextWindow,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify(
      {
        quietStartup: true,
        enableInstallTelemetry: false,
        // Never load project-local .pi settings or extensions from a workspace.
        defaultProjectTrust: "never",
      },
      null,
      2,
    ),
  );
}

/** Blocks path traversal out of the sandbox in test helpers. */
function resolveInsideWorkspace(workspaceDir: string, relativePath: string): string {
  const target = resolve(workspaceDir, relativePath);
  if (target !== workspaceDir && !target.startsWith(workspaceDir + "/")) {
    throw new Error(`pi eval harness: "${relativePath}" resolves outside the workspace`);
  }
  return target;
}

/**
 * Creates an isolated pi sandbox without registering any cleanup.
 *
 * Use this for a multi-stage suite where every test shares one workspace, so
 * later stages build on what earlier stages produced: create it in `beforeAll`
 * and call `harness.cleanup()` in `afterAll`. `createPiHarness()` cannot serve
 * that case because it registers `onTestFinished`, which requires a test.
 */
export async function createPiSuiteHarness(options: PiHarnessOptions = {}): Promise<PiHarness> {
  return buildPiHarness(options);
}

/**
 * Creates an isolated pi sandbox: a fresh config dir and an empty workspace,
 * both under a private temp root, removed when the test finishes.
 *
 * Must be called from inside a test — cleanup registers via onTestFinished.
 * For a suite that shares one workspace across stages, use
 * `createPiSuiteHarness()` instead.
 */
export async function createPiHarness(options: PiHarnessOptions = {}): Promise<PiHarness> {
  const harness = await buildPiHarness(options);

  onTestFinished(async () => {
    if (KEEP_EVAL_TMP) {
      console.log(`[pi-eval] kept sandbox: ${harness.rootDir}`);
      return;
    }
    await harness.cleanup();
  });

  return harness;
}

async function buildPiHarness(options: PiHarnessOptions = {}): Promise<PiHarness> {
  const model = options.model ?? (await resolveHarnessModel());

  await assertEvalModelAvailable(model);
  const modelInfo = await getEvalModelInfo(model);
  // Load before writing the config: the context window pi is told about has to
  // be the one the resident instance actually has, and that is only knowable
  // once the model is loaded.
  const contextWindow = await ensureEvalModelLoaded(model);

  const rootDir = await mkdtemp(join(tmpdir(), "pi-eval-"));
  const configDir = join(rootDir, "config");
  const workspaceDir = join(rootDir, "workspace");

  await writePiConfigDir(configDir, modelInfo, contextWindow);
  await mkdir(workspaceDir, { recursive: true });

  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const target = resolveInsideWorkspace(workspaceDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  let runCount = 0;

  const harness: PiHarness = {
    rootDir,
    configDir,
    workspaceDir,
    model,

    async runPiAgent(prompt, runOptions = {}) {
      const runIndex = runCount++;
      const args = [
        "--print",
        "--mode",
        "json",
        "--provider",
        PI_EVAL_PROVIDER_ID,
        "--model",
        model,
        // A blank config has none of these, but being explicit keeps a
        // half-installed package or stray file from changing agent behaviour.
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-approve",
      ];
      if (!options.contextFiles) args.push("--no-context-files");
      if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
      if (options.tools?.length) args.push("--tools", options.tools.join(","));
      args.push(prompt);

      const timeoutMs = runOptions.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      const startedAt = Date.now();

      const child = spawn("pi", args, {
        cwd: workspaceDir,
        // stdin must be closed: with an open stdin pi waits for input and
        // never exits, even under --print.
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: configDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          rejectPromise(
            new Error(
              `pi eval harness: run timed out after ${timeoutMs}ms.\n` +
                `workspace: ${workspaceDir}\n--- stderr ---\n${stderr}\n--- stdout tail ---\n${stdout.slice(-2000)}`,
            ),
          );
        }, timeoutMs);

        child.on("error", (error) => {
          clearTimeout(timer);
          rejectPromise(new Error(`pi eval harness: failed to spawn pi: ${error.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolvePromise(code);
        });
      });

      const durationMs = Date.now() - startedAt;

      // Always persist raw output so a failure can be inspected after the fact.
      await writeFile(join(rootDir, `run-${runIndex}.stdout.jsonl`), stdout);
      await writeFile(join(rootDir, `run-${runIndex}.stderr.log`), stderr);

      const events = parsePiEventStream(stdout);
      if (events.length === 0) {
        throw new Error(
          `pi eval harness: pi produced no JSON events (exit ${exitCode}).\n` +
            `--- stderr ---\n${stderr}\n--- stdout ---\n${stdout.slice(0, 2000)}`,
        );
      }

      const assistantMessages = collectAssistantMessages(events);
      const toolCalls = collectToolCalls(events);
      const finalText = extractFinalText(assistantMessages);
      const stopReason = assistantMessages.at(-1)?.stopReason;
      const errorMessage = extractErrorMessage(assistantMessages);
      const usage = sumPiUsage(assistantMessages);

      recordPiEvalRun({
        prompt,
        model,
        baseUrl: PI_EVAL_BASE_URL,
        finalText: truncateForReport(finalText),
        stopReason,
        errorMessage: errorMessage ? truncateForReport(errorMessage) : undefined,
        toolCalls: toolCalls.map((call) => ({
          name: call.name,
          args: stringifyToolField(call.args),
          result: stringifyToolField(call.result),
          isError: call.isError,
        })),
        usage,
        contextWindow,
        durationMs,
        exitCode,
        sandboxDir: rootDir,
      });

      return {
        exitCode,
        events,
        assistantMessages,
        finalText,
        toolCalls,
        toolNames: toolCalls.map((call) => call.name),
        stopReason,
        errorMessage,
        usage,
        stdout,
        stderr,
        durationMs,
      };
    },

    async readWorkspaceFile(relativePath) {
      return readFile(resolveInsideWorkspace(workspaceDir, relativePath), "utf8");
    },

    async readConfigFile(relativePath) {
      return readFile(join(configDir, relativePath), "utf8");
    },

    async workspaceFileExists(relativePath) {
      try {
        await access(resolveInsideWorkspace(workspaceDir, relativePath));
        return true;
      } catch {
        return false;
      }
    },

    async writeWorkspaceFile(relativePath, contents) {
      const target = resolveInsideWorkspace(workspaceDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    },

    async cleanup() {
      if (KEEP_EVAL_TMP) return;
      await rm(rootDir, { recursive: true, force: true });
    },
  };

  return harness;
}
