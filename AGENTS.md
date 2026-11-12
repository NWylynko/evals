# AGENTS.md

keep this file up to date.

Vitest eval framework for the [pi](https://pi.dev) coding agent. Every eval boots a
throwaway pi install against a local LM Studio server and grades what the agent did.

## Layout

```
src/
  pi-harness/          # the framework (domain vertical)
    piHarnessConfig.ts # endpoint, provider id, model list, LM Studio compat flags
    piEventStream.ts   # parses pi's --mode json JSONL into events/tool calls/text
    piHarness.ts       # createPiHarness(): sandbox + runPiAgent()
    piHarnessModels.ts # discovers the model matrix from /v1/models
    piHarnessLoad.ts   # loads a model, reads back its REAL context window
    runEvalMatrix.ts   # `pnpm eval`: one vitest run per model, model-outer
    piEvalReport.ts    # run records + standalone HTML rendering
    piEvalReporter.ts  # vitest reporter → per-model shard + merged HTML
    serveEvalReport.ts # `pnpm report`: fastify server for the HTML report
    index.ts           # public surface — import from here
  evals/
    *.eval.test.ts     # the evals themselves
```

`vitest.config.ts` only picks up `src/**/*.eval.test.ts`.

## Hard-won facts about driving pi

These were established by experiment; do not "simplify" them away.

- **stdin must be closed.** `spawn(..., stdio: ["ignore", ...])`. With an inherited
  stdin, `pi --print` waits for input and never exits — it looks exactly like a
  hung model.
- **`PI_CODING_AGENT_DIR` is the isolation lever.** It overrides `~/.pi/agent`.
  Setting `HOME` also works but drags along everything else that reads `HOME`.
- **LM Studio needs `compat.supportsDeveloperRole: false` and
  `supportsReasoningEffort: false`.** pi sends the `developer` role for
  reasoning-capable models and LM Studio rejects it.
- **A provider needs a non-empty `apiKey`** even when the server ignores it, or
  pi treats the models as unauthenticated and hides them.
- **Tools auto-approve in `--print` mode**, and non-interactive runs never show
  the project-trust prompt. `defaultProjectTrust: "never"` keeps a workspace's
  own `.pi/` from being loaded regardless.
- **Model ids are the LM Studio ids** (`prism-ml/bonsai-27b`), passed as
  `--provider eval-local --model <id>`.

## Endpoint

`PI_EVAL_BASE_URL`, required, no default. Schema in `.env.schema` (varlock, loaded
by `piHarnessConfig.ts`); the value lives in Infisical (`dev`) and the `pnpm eval*`
scripts inject it with `infisical run`. The repo is meant to be public — keep hostnames out of it.

Two model endpoints, and the difference matters:

- `/v1/models` — OpenAI spec. Ids only. Eval traffic uses this base URL.
- `/api/v1/models` — LM Studio's native API. Returns `type`, `params_string`,
  `max_context_length` and a `capabilities` object (`vision`,
  `trained_for_tool_use`, `reasoning` with `allowed_options`/`default`).

**Discovery uses `/api/v1/models`.** It is the only way to know what a model
actually is; the OpenAI endpoint cannot tell you. The matrix is every model with
`type !== "embedding"` and `trained_for_tool_use`, and the generated `models.json`
declares each model's real `reasoning`, `input` (vision) and `contextWindow`
instead of guessing. This couples discovery to LM Studio — the eval traffic itself
stays pure OpenAI spec.

There is also an older `/api/v0/models`; it reports capabilities as a flat array
(`["tool_use"]`) with no reasoning info, and calls embeddings `"embeddings"` rather
than `"embedding"`. Don't use it.

```bash
curl -s "${PI_EVAL_BASE_URL%/v1}/api/v1/models" | jq '.models[] | {key, type, capabilities}'
```

Every chat model on this server reasons, with thinking **on by default**. Do not
assume a local model is non-reasoning.

## Context windows: the ceiling is not the window

`max_context_length` in the catalog is what a model **supports**. It is not what
the resident instance was **loaded with**, and the gap is huge: nemotron's
ceiling is 262144 and LM Studio loads it at **8192**.

Declaring the ceiling to pi is how the eval framework's worst bug worked — pi
believed it had 32x the room it had, never compacted, and a run died on a
provider 400 the moment `ls -R` returned a big result. In the report that is
indistinguishable from the model being bad at the task.

So `piHarnessLoad.ts` loads the model itself and reads the window back off the
resident instance. Facts established by experiment, all of them load-bearing:

- The real window is `loaded_instances[0].config.context_length` from
  `/api/v1/models`. **Only this is trustworthy.**
- `POST /api/v1/models/load` takes `model`, `context_length`, `parallel`,
  `flash_attention`, `eval_batch_size`, and returns once the model is resident —
  nothing to poll. Unload is `POST /api/v1/models/unload` by `instance_id`
  (*not* by model).
- **`context_length` on the request is advisory.** nemotron honours it;
  google/gemma-4-e4b ignores it and keeps its saved 131072. Never trust the
  requested value — always read back.
- **An explicit load does not evict.** JIT loading keeps one model resident, but
  loading through the API stacks instances (`<id>`, `<id>:2`, …) until the box
  is out of memory. The harness unloads other models first to preserve the
  one-resident-model behaviour the matrix depends on.
- Ground truth, when you need to settle an argument: send an oversized prompt
  and read `n_ctx` out of the 400.

We take the default window and report it rather than requesting a bigger one —
the matrix should measure the model as it is actually served. The consequence
is real and intended: nemotron at 8192 fails the agentic evals, now legibly
(`stop: length`, and a `ctx:` chip in the report) instead of as a 400.

Models are discovered at runtime, never hardcoded. **When working on the framework
itself, always narrow the matrix** or a single change costs a full 8-model run:

```bash
PI_EVAL_MODELS=google/gemma-4-e4b pnpm eval
PI_EVAL_MODELS=google/gemma-4-e4b,prism-ml/bonsai-27b pnpm eval
```

Those two load fastest; the rest (27b–70b) are much slower.

## Why the matrix is model-outer

The server keeps one model resident, so each switch is a full unload/load. Vitest
runs files sequentially, so a model loop inside the tests would reload models once
per file. `runEvalMatrix.ts` inverts it — one vitest process per model — so the cost
is M−1 switches no matter how many eval files exist.

Consequence: results arrive as per-model shards in `.eval-results/shards/`, and the
reporter re-renders the merged HTML from all shards after every run. Don't "simplify"
the reporter into holding state in memory; it would break the multi-process matrix.

Before starting, the matrix runner deletes **only** the shards it is about to
replace, plus any whose model the server no longer serves. It must not wipe
`.eval-results/` wholesale: a narrowed `PI_EVAL_MODELS` run is the normal way to
iterate, and wiping would make that silently destroy a full matrix report (this
happened once — a one-model debug run erased an eight-model result).

Because columns can therefore come from different runs, each model section in the
report prints the timestamp of the run that produced it.

## How the report gets its data

`runPiAgent()` calls `recordPiEvalRun()`, which appends a record to the current
test's `meta` via `getCurrentTest()` (from the public `vitest/suite` subpath).
Vitest serializes `meta` from the worker to the main process, where
`PiEvalHtmlReporter.onTestRunEnd()` reads it back with `testCase.meta()`.

That is why records must stay small and plain-serializable: raw stdout stays on
disk in the sandbox and never goes into `meta`. Long strings are capped by
`truncateForReport()`.

The alternative — having the reporter join results against a JSONL side-file by
test name — was rejected: `meta` needs no join key and cannot go stale.

## Debugging a failing eval

`pnpm report` serves `.eval-results/` on :4321 (`PORT` to change) with
`cache-control: no-store`, so re-running the matrix and refreshing shows the new
report without restarting the server. The no-store header comes from an `onSend`
hook, not `@fastify/static`'s `setHeaders` — that callback is typed as a raw
response, not a `FastifyReply`.

`KEEP_EVAL_TMP=1 pnpm eval` keeps the sandbox and prints its path. Inside it:

- `run-N.stdout.jsonl` — the full pi event stream
- `run-N.stderr.log` — pi's stderr
- `workspace/` — exactly what the agent left behind
- `config/` — the generated blank pi config

## Multi-stage evals

`createPiHarness()` registers cleanup through `onTestFinished`, so it only works
inside a test and gives each test its own workspace. For a suite whose stages build
on each other (see `nextjs-app.eval.test.ts`), use `createPiSuiteHarness()` in
`beforeAll` and call `cleanup()` in `afterAll` — same sandbox, caller-owned
lifetime.

Gate each stage on the previous one with a `completedStage` counter and
`ctx.skip()`. Vitest evaluates `skipIf` at collection time, before any stage has
run, so it cannot express this — the check has to be inside the test body.

Stage 1 of the Next.js suite runs `create-next-app`, which downloads and installs
Next.js. It gets `timeoutMs: 540_000` with a 600s vitest timeout; keep the harness
timeout below the vitest one so the harness error (which carries the transcript)
is what you see. `create-next-app` took ~13s by hand with a warm npm cache.

## Verifying through a real browser

Grepping source proves nothing: a file can contain the right string while the app
fails to compile, the route 404s, or the component never renders. Web-app evals
therefore boot the app and drive it with Playwright.

`piDevServer.ts` starts the dev server in the workspace and waits for the server's
own output to report a URL *and* readiness — **never a sleep**. A fixed delay is
either a flake or wasted time, and the server already announces both. The URL comes
from what the server prints, so if port 3000 is taken and Next picks 3001, we follow
it instead of assuming.

The child is spawned `detached` so `stop()` can `process.kill(-pid)` the whole
group. Next spawns workers that survive killing the parent alone and would hold the
port for the rest of the suite. Don't "simplify" that to `child.kill()`.

One dev server serves all stages — Next recompiles per request, so later stages see
the agent's edits without a restart. Use `expect.poll` for assertions on page
content: the first hit on a route pays for compilation.

Chromium comes from the machine's existing `~/.cache/ms-playwright`; `playwright` is
a project dep but no browser download is needed.

## Conventions

- Evals are end-to-end: drive the real `pi` binary, then assert on the
  filesystem and the event stream, never on mocks.
- Local inference serves one request at a time, so vitest runs evals serially
  (`fileParallelism: false`). Do not turn that on.
- The harness fails loudly and early: it preflights `/v1/models` before spawning
  pi, so an unreachable host errors in ~300ms instead of stalling for minutes.
- `createPiHarness()` must be called inside a test — cleanup registers through
  vitest's `onTestFinished`.
