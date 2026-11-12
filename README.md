# pi-evals

Vitest eval framework for the [pi](https://pi.dev) coding agent.

Each eval gets a **fresh, blank pi install** and its **own temp filesystem**, pointed at a
local LM Studio server over the OpenAI spec. Nothing touches your real `~/.pi/agent`.

## Run

```bash
pnpm install
pnpm eval          # full matrix: every eval against every served model
pnpm eval:single   # one vitest run against a single model (fast iteration)
pnpm eval:watch    # watch mode
pnpm report        # serve the HTML report at http://127.0.0.1:4321
pnpm typecheck
```

**Every served model is a lot of models.** While developing, narrow the matrix:

```bash
PI_EVAL_MODELS=google/gemma-4-e4b pnpm eval                        # one model
PI_EVAL_MODELS=google/gemma-4-e4b,prism-ml/bonsai-27b pnpm eval    # two
```

Those two load fastest. `PI_EVAL_MODELS` also picks the model for `eval:single`.

Requires the `pi` CLI on `PATH` and an LM Studio server, set by `PI_EVAL_BASE_URL`
(e.g. `http://localhost:1234/v1`). It is required with no default — the schema is in
`.env.schema` and [varlock](https://varlock.dev) fails at startup if it's missing.

The `pnpm eval*` scripts inject it from Infisical (`infisical run --env=dev`). Without
Infisical, set it yourself and call the commands directly:

```bash
PI_EVAL_BASE_URL=http://localhost:1234/v1 node src/pi-harness/runEvalMatrix.ts
PI_EVAL_BASE_URL=http://localhost:1234/v1 npx vitest run
```

## Writing an eval

```ts
import { describe, expect, it } from "vitest";
import { EVAL_MODELS, createPiHarness } from "../pi-harness/index.ts";

describe("pi agent: write a file", () => {
  it("creates hello.txt with the requested content in its workspace", async () => {
    const harness = await createPiHarness({ model: EVAL_MODELS.bonsai27b });

    const run = await harness.runPiAgent(
      "Create a file named hello.txt in the current directory containing exactly: Hello, World!",
    );

    expect(run.stopReason).toBe("stop");
    expect(run.toolNames).toContain("write");
    expect((await harness.readWorkspaceFile("hello.txt")).trim()).toBe("Hello, World!");
  });
});
```

Files must match `src/**/*.eval.test.ts`.

### Multi-stage evals

When later prompts build on what earlier ones produced, share one workspace across
the suite with `createPiSuiteHarness()` — it skips the `onTestFinished` registration
that `createPiHarness()` uses, so you own cleanup:

```ts
describe("nextjs app", () => {
  let harness: PiHarness;
  let completedStage = 0;

  beforeAll(async () => { harness = await createPiSuiteHarness(); });
  afterAll(async () => { await harness?.cleanup(); });

  it("stage 1: …", async () => { /* … */ completedStage = 1; });

  it("stage 2: …", async (ctx) => {
    if (completedStage < 1) ctx.skip("stage 1 did not complete");
    // …
  });
});
```

Gate each stage on the previous one. Without it, one broken stage cascades into a
pile of failures that hide which one actually broke. Give slow stages a bigger
budget via `runPiAgent(prompt, { timeoutMs })` plus vitest's per-test timeout — keep
the harness timeout lower so its error (which carries the transcript) wins.

### Verifying in a browser

For web-app evals, run the thing rather than grepping its source — a file can hold
the right string while the app never compiles or the route 404s.
`startWorkspaceDevServer()` boots the app in the workspace and resolves once the
server reports its URL and readiness (parsed from its output, no sleeps), then
Playwright drives it:

```ts
devServer = await startWorkspaceDevServer({
  cwd: `${harness.workspaceDir}/myapp`,
  command: "npx",
  args: ["--no-install", "next", "dev"],
  urlPattern: NEXT_DEV_URL_PATTERN,
  readyPattern: NEXT_DEV_READY_PATTERN,
});
browser = await chromium.launch({ headless: true });
```

Stop the server and close the browser in `afterAll`. The server runs in its own
process group so `stop()` takes down the worker tree with it. See
`nextjs-app.eval.test.ts` for the full pattern.

### `createPiHarness(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | `prism-ml/bonsai-27b` | Model id, from `EVAL_MODELS` |
| `files` | `{}` | Files seeded into the workspace before the run |
| `systemPrompt` | pi's built-in | Replace the system prompt |
| `tools` | all built-ins | Allowlist of tool names |
| `contextFiles` | `false` | Let pi discover `AGENTS.md` / `CLAUDE.md` |

Returns a harness with `runPiAgent()`, `readWorkspaceFile()`, `writeWorkspaceFile()`,
`cleanup()`, and the `rootDir` / `configDir` / `workspaceDir` paths.

### `runPiAgent(prompt, { timeoutMs })` result

`finalText`, `toolCalls` (name, args, result, isError), `toolNames`, `stopReason`,
`assistantMessages`, `events` (the raw pi event stream), `stdout`, `stderr`,
`exitCode`, `durationMs`.

## The model matrix

Models are **discovered at startup** from LM Studio's native `/api/v1/models` —
nothing is hardcoded. The matrix is every model that is not an embedding model and
is `trained_for_tool_use`, sorted for a stable order.

That endpoint (unlike the OpenAI-spec `/v1/models`, which returns only ids) reports
each model's capabilities, so the generated pi config declares the model's real
`reasoning` and `input` (vision) rather than assuming defaults. Discovery is
therefore LM Studio-specific; the eval traffic itself is plain OpenAI spec against
`PI_EVAL_BASE_URL`.

The **context window does not come from the catalog.** `max_context_length` is what
a model supports, not what it was loaded with — LM Studio serves nemotron at 8192
against a 262144 ceiling. The harness loads the model through LM Studio's API and
reads the window back off the resident instance, then declares *that* to pi, so pi
compacts against the room it really has. Each run's window shows as a `ctx:` chip in
the report, which is what makes a `stop: length` failure legible as "served small"
rather than "bad model".

The server holds one model in memory at a time, so every switch costs a full
unload/load. `pnpm eval` therefore loops **model-outer**: it runs the whole suite
against one model, then moves to the next. That is one load per model, regardless
of how many eval files exist.

This is why `pnpm eval` runs `runEvalMatrix.ts` rather than vitest directly. Vitest
executes test files sequentially, so a model loop *inside* the tests would reload
models once per file (N files × M models switches). Making the model the outer
loop — one vitest process per model — costs exactly M−1 switches.

Evals that call `createPiHarness()` with no model run against whichever model the
current pass has loaded. Pin one when an eval is model-specific:

```ts
const harness = await createPiHarness({ model: "prism-ml/bonsai-27b" });
```

## Report

Every `pnpm eval` writes a standalone HTML report to `.eval-results/index.html` and
prints the path. Open it directly in a browser — no server or assets needed.

It opens with a **matrix** — evals down the side, models across the top — so you can
see at a glance which models pass which evals. Below that, per model, each eval
expands to its full detail: the prompt, every tool call with args and result, the
agent's final response, token usage, duration, and the sandbox path. Failed evals
expand automatically and include the assertion error **alongside the full
transcript** — the transcript is the reason the report exists, so it is captured on
failure too.

### Viewing it

The file opens fine straight from disk, but `pnpm report` (fastify) is easier to live
with:

```bash
pnpm report              # http://127.0.0.1:4321
PORT=8080 pnpm report    # different port
```

It serves `.eval-results/` from disk with `cache-control: no-store`, so you can leave
the tab open, re-run `pnpm eval`, and just refresh — no restart. Shard JSON is served
too (`/shards/<model>.json`) if you want the raw results.

Each vitest process writes a per-model shard to `.eval-results/shards/` and then
re-renders the merged HTML from every shard on disk. That is what lets the
one-process-per-model matrix produce a single combined report — and it means the
report is valid after any run, including `eval:single` and runs that fail.

Shards accumulate: a narrowed `PI_EVAL_MODELS` run refreshes only those models'
columns and leaves the others in place, so iterating on one model doesn't throw away
a full matrix. Shards for models the server no longer serves are dropped
automatically. Each model section shows the timestamp of the run behind it, so an
older column is visible as such. To start completely fresh, delete `.eval-results/`.

The report is generated by `PiEvalHtmlReporter` (`src/pi-harness/piEvalReporter.ts`),
wired up in `vitest.config.ts`. Change the destination with:

```ts
reporters: ["verbose", new PiEvalHtmlReporter({ outputFile: "reports/evals.html" })],
```

## Isolation

Per test, under a private `mkdtemp` root:

```
/tmp/pi-eval-XXXXXX/
├── config/      → PI_CODING_AGENT_DIR: generated models.json + settings.json,
│                  its own sessions/ and auth.json
├── workspace/   → the agent's cwd
└── run-N.*      → captured stdout/stderr per run
```

pi runs with `--no-extensions --no-skills --no-prompt-templates --no-themes
--no-approve` (and `--no-context-files` unless opted in), plus `PI_OFFLINE=1`, so a
run sees only what the eval put there. The whole root is deleted when the test finishes.

## Configuration

| Env var | Purpose |
| --- | --- |
| `PI_EVAL_BASE_URL` | LM Studio OpenAI-spec base URL, incl. `/v1`. Required |
| `PI_EVAL_MODELS` | Comma-separated matrix override. Unset = every served model |
| `PI_EVAL_MODEL` | Pins one vitest process to one model; set by the matrix runner |
| `KEEP_EVAL_TMP=1` | Keep the sandbox and print its path, for debugging |

A `PI_EVAL_MODELS` entry the server isn't serving is a hard error listing what *is*
served — a typo should not silently shrink the matrix.

The harness checks `/v1/models` before each run, so a wrong host or an unloaded model
fails immediately with the list of what *is* available.
