/**
 * Eval reporting: what each pi run did, and how to render it as a standalone
 * HTML page.
 *
 * Records ride to the reporter on vitest's per-test `meta`, which is serialized
 * from the worker to the main process. Keep everything here plain and small —
 * raw stdout stays on disk in the sandbox, not in the report.
 */

import { getCurrentTest } from "vitest/suite";

/** Guards against a runaway tool result bloating the report. */
const MAX_TEXT = 4_000;
const MAX_TOOL_FIELD = 2_000;

export const PI_EVAL_META_KEY = "piEvalRuns";

export interface PiEvalToolCallRecord {
  name: string;
  args: string;
  result: string;
  isError: boolean;
}

export interface PiEvalRunRecord {
  prompt: string;
  model: string;
  baseUrl: string;
  finalText: string;
  stopReason: string | undefined;
  errorMessage?: string | undefined;
  toolCalls: PiEvalToolCallRecord[];
  usage: { input: number; output: number; totalTokens: number };
  /**
   * The context window declared to pi — the resident instance's real one, not
   * the model's ceiling. Recorded because it is the missing piece when a run
   * stops on "length" or dies on an exceed-context 400: without it, a model
   * served at 8192 against a 262144 ceiling looks merely incompetent.
   */
  contextWindow: number;
  durationMs: number;
  exitCode: number | null;
  sandboxDir: string;
}

export interface PiEvalTestReport {
  name: string;
  module: string;
  state: "passed" | "failed" | "skipped" | "pending";
  durationMs: number;
  errors: string[];
  runs: PiEvalRunRecord[];
}

export interface PiEvalReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  generatedAt: string;
}

/** One vitest process pinned to one model. The matrix is a list of these. */
export interface PiEvalShard {
  model: string;
  generatedAt: string;
  reports: PiEvalTestReport[];
}

export function truncateForReport(value: string, limit = MAX_TEXT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

export function stringifyToolField(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncateForReport(text ?? "", MAX_TOOL_FIELD);
}

/**
 * Attaches a run record to the currently executing test so the reporter can
 * pick it up. Throws if called outside a test — the harness already requires a
 * test context, so a missing one means real misuse, not a soft edge case.
 */
export function recordPiEvalRun(record: PiEvalRunRecord): void {
  const currentTest = getCurrentTest();
  if (!currentTest) {
    throw new Error(
      "pi eval harness: recordPiEvalRun() called outside a running test; " +
        "createPiHarness() must be used inside it()/test().",
    );
  }
  const meta = currentTest.meta as Record<string, unknown>;
  const runs = (meta[PI_EVAL_META_KEY] as PiEvalRunRecord[] | undefined) ?? [];
  runs.push(record);
  meta[PI_EVAL_META_KEY] = runs;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderToolCall(call: PiEvalToolCallRecord): string {
  const status = call.isError ? "error" : "ok";
  return `
    <details class="tool ${status}">
      <summary><span class="tool-name">${escapeHtml(call.name)}</span>${
        call.isError ? '<span class="badge badge-fail">error</span>' : ""
      }</summary>
      ${call.args ? `<div class="field-label">args</div><pre>${escapeHtml(call.args)}</pre>` : ""}
      ${call.result ? `<div class="field-label">result</div><pre>${escapeHtml(call.result)}</pre>` : ""}
    </details>`;
}

function renderRun(run: PiEvalRunRecord, index: number): string {
  const toolCalls = run.toolCalls.length
    ? run.toolCalls.map(renderToolCall).join("")
    : '<p class="empty">No tools called.</p>';

  return `
    <div class="run">
      <div class="run-head">
        <span class="run-index">run ${index + 1}</span>
        <span class="chip">${escapeHtml(run.model)}</span>
        <span class="chip">${formatDuration(run.durationMs)}</span>
        <span class="chip">${run.usage.totalTokens.toLocaleString()} tok</span>
        <span class="chip">ctx: ${
          // Shards written before this field existed are still on disk and are
          // still worth reading; say so rather than inventing a number.
          typeof run.contextWindow === "number" ? run.contextWindow.toLocaleString() : "unrecorded"
        }</span>
        <span class="chip">stop: ${escapeHtml(run.stopReason ?? "unknown")}</span>
      </div>

      ${
        run.errorMessage
          ? `<div class="field-label">provider error</div><pre class="error">${escapeHtml(run.errorMessage)}</pre>`
          : ""
      }
      <div class="field-label">prompt</div>
      <pre class="prompt">${escapeHtml(run.prompt)}</pre>

      <div class="field-label">tool calls (${run.toolCalls.length})</div>
      ${toolCalls}

      <div class="field-label">final response</div>
      <pre class="final">${escapeHtml(run.finalText) || '<span class="empty">(empty)</span>'}</pre>

      <div class="run-foot">
        <code>${escapeHtml(run.baseUrl)}</code> · sandbox <code>${escapeHtml(run.sandboxDir)}</code>
      </div>
    </div>`;
}

function renderTest(report: PiEvalTestReport): string {
  const badge =
    report.state === "passed"
      ? '<span class="badge badge-pass">passed</span>'
      : report.state === "failed"
        ? '<span class="badge badge-fail">failed</span>'
        : `<span class="badge badge-skip">${report.state}</span>`;

  const errors = report.errors.length
    ? `<div class="field-label">failure</div><pre class="error">${report.errors
        .map(escapeHtml)
        .join("\n\n")}</pre>`
    : "";

  const runs = report.runs.length
    ? report.runs.map(renderRun).join("")
    : '<p class="empty">No pi runs recorded for this test.</p>';

  return `
    <section class="test ${report.state}" open>
      <details ${report.state === "failed" ? "open" : ""}>
        <summary>
          ${badge}
          <span class="test-name">${escapeHtml(report.name)}</span>
          <span class="test-duration">${formatDuration(report.durationMs)}</span>
        </summary>
        <div class="test-body">
          <div class="module">${escapeHtml(report.module)}</div>
          ${errors}
          ${runs}
        </div>
      </details>
    </section>`;
}

/**
 * Rows are evals, columns are models. This is the view that answers the actual
 * question an eval matrix exists to answer: which models pass which evals.
 */
function renderMatrix(shards: PiEvalShard[]): string {
  const evalNames = [...new Set(shards.flatMap((shard) => shard.reports.map((r) => r.name)))].sort();
  if (evalNames.length === 0 || shards.length === 0) return "";

  const header = shards
    .map((shard) => `<th title="${escapeHtml(shard.model)}">${escapeHtml(shard.model)}</th>`)
    .join("");

  const rows = evalNames
    .map((name) => {
      const cells = shards
        .map((shard) => {
          const report = shard.reports.find((r) => r.name === name);
          if (!report) return '<td class="cell cell-missing" title="not run">·</td>';
          const symbol = report.state === "passed" ? "✓" : report.state === "failed" ? "✕" : "–";
          return `<td class="cell cell-${report.state}" title="${escapeHtml(report.state)} · ${formatDuration(
            report.durationMs,
          )}">${symbol}</td>`;
        })
        .join("");
      return `<tr><th class="row-name">${escapeHtml(name)}</th>${cells}</tr>`;
    })
    .join("");

  return `
  <h2>Matrix</h2>
  <div class="matrix-wrap">
    <table class="matrix">
      <thead><tr><th class="corner">eval</th>${header}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** Columns can come from different runs, so each one states when it was produced. */
function formatShardTime(generatedAt: string): string {
  return generatedAt.replace("T", " ").slice(0, 16) + " UTC";
}

function renderModelSection(shard: PiEvalShard): string {
  const passed = shard.reports.filter((r) => r.state === "passed").length;
  const failed = shard.reports.filter((r) => r.state === "failed").length;

  return `
  <div class="model-group">
    <h2 class="model-heading">
      <span class="model-id">${escapeHtml(shard.model)}</span>
      <span class="badge ${failed > 0 ? "badge-fail" : "badge-pass"}">${passed}/${shard.reports.length} passed</span>
      <span class="shard-time">${formatShardTime(shard.generatedAt)}</span>
    </h2>
    ${shard.reports.map(renderTest).join("")}
  </div>`;
}

export function renderPiEvalReportHtml(shards: PiEvalShard[]): string {
  const reports = shards.flatMap((shard) => shard.reports);
  const summary: PiEvalReportSummary = {
    total: reports.length,
    passed: reports.filter((report) => report.state === "passed").length,
    failed: reports.filter((report) => report.state === "failed").length,
    skipped: reports.filter((report) => report.state === "skipped").length,
    durationMs: reports.reduce((total, report) => total + report.durationMs, 0),
    generatedAt: new Date().toISOString(),
  };

  const status = summary.failed > 0 ? "fail" : "pass";
  const totalTokens = reports
    .flatMap((report) => report.runs)
    .reduce((total, run) => total + run.usage.totalTokens, 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi eval report</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #fff; --border: #e2e5ea; --text: #14171f;
    --muted: #666f7d; --pass: #197f46; --fail: #c02525; --skip: #8a6d1f;
    --accent: #3454d1; --code-bg: #f0f2f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1116; --panel: #171a21; --border: #272b34; --text: #e6e8ec;
      --muted: #98a0ad; --pass: #4ac97e; --fail: #ff6b6b; --skip: #d6b45c;
      --accent: #7b93ff; --code-bg: #10131a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .generated { color: var(--muted); font-size: .85rem; margin-bottom: 1.5rem; }
  .summary {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: .75rem; margin-bottom: 2rem;
  }
  .stat {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: .85rem 1rem;
  }
  .stat .k { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
  .stat .v { font-size: 1.5rem; font-weight: 600; margin-top: .15rem; }
  .stat.pass .v { color: var(--pass); }
  .stat.fail .v { color: var(--fail); }
  .banner {
    border-radius: 10px; padding: .75rem 1rem; margin-bottom: 1.5rem;
    font-weight: 600; border: 1px solid var(--border);
  }
  .banner.pass { background: color-mix(in srgb, var(--pass) 12%, transparent); color: var(--pass); }
  .banner.fail { background: color-mix(in srgb, var(--fail) 12%, transparent); color: var(--fail); }
  section.test {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; margin-bottom: .85rem; overflow: hidden;
  }
  summary { cursor: pointer; padding: .85rem 1rem; display: flex; align-items: center; gap: .6rem; }
  summary::-webkit-details-marker { display: none; }
  .test-name { font-weight: 600; flex: 1; }
  .test-duration { color: var(--muted); font-size: .85rem; }
  .test-body { padding: 0 1rem 1rem; }
  .module { color: var(--muted); font-size: .8rem; font-family: ui-monospace, monospace; margin-bottom: .75rem; }
  .badge {
    font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: .2rem .45rem; border-radius: 5px; white-space: nowrap;
  }
  .badge-pass { background: color-mix(in srgb, var(--pass) 18%, transparent); color: var(--pass); }
  .badge-fail { background: color-mix(in srgb, var(--fail) 18%, transparent); color: var(--fail); }
  .badge-skip { background: color-mix(in srgb, var(--skip) 18%, transparent); color: var(--skip); }
  .run { border: 1px solid var(--border); border-radius: 8px; padding: .85rem; margin-bottom: .75rem; }
  .run-head { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; margin-bottom: .6rem; }
  .run-index { font-weight: 600; margin-right: .3rem; }
  .chip {
    font-size: .75rem; background: var(--code-bg); border: 1px solid var(--border);
    padding: .15rem .45rem; border-radius: 999px; color: var(--muted);
  }
  .field-label {
    font-size: .7rem; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); margin: .7rem 0 .25rem; font-weight: 600;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
    padding: .6rem .75rem; margin: 0; overflow-x: auto;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;
    word-break: break-word;
  }
  pre.error { border-color: var(--fail); color: var(--fail); }
  .tool { border: 1px solid var(--border); border-radius: 6px; margin-bottom: .4rem; }
  .tool summary { padding: .45rem .7rem; font-size: .9rem; }
  .tool-name { font-family: ui-monospace, monospace; color: var(--accent); font-weight: 600; }
  .tool > .field-label, .tool > pre { margin-left: .7rem; margin-right: .7rem; }
  .tool > pre { margin-bottom: .7rem; }
  .empty { color: var(--muted); font-style: italic; font-size: .9rem; margin: .2rem 0; }
  .run-foot { color: var(--muted); font-size: .75rem; margin-top: .7rem; }
  code { font-family: ui-monospace, monospace; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
  .matrix-wrap {
    overflow-x: auto; background: var(--panel);
    border: 1px solid var(--border); border-radius: 10px;
  }
  table.matrix { border-collapse: collapse; width: 100%; font-size: .85rem; }
  table.matrix th, table.matrix td { border-bottom: 1px solid var(--border); padding: .5rem .7rem; }
  table.matrix thead th {
    text-align: left; font-family: ui-monospace, monospace; font-weight: 600;
    color: var(--muted); white-space: nowrap; font-size: .78rem;
  }
  table.matrix .corner { color: var(--muted); }
  table.matrix .row-name { text-align: left; font-weight: 500; }
  table.matrix tbody tr:last-child th, table.matrix tbody tr:last-child td { border-bottom: 0; }
  .cell { text-align: center; font-weight: 700; width: 1%; }
  .cell-passed { color: var(--pass); }
  .cell-failed { color: var(--fail); }
  .cell-skipped, .cell-pending, .cell-missing { color: var(--muted); }
  .model-group { margin-bottom: 2rem; }
  .model-heading { display: flex; align-items: center; gap: .6rem; margin: 1.25rem 0 .6rem; }
  .model-id { font-family: ui-monospace, monospace; font-size: .95rem; }
  .shard-time { color: var(--muted); font-size: .72rem; font-weight: 400; margin-left: auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>pi eval report</h1>
  <p class="generated">Generated ${escapeHtml(summary.generatedAt)}</p>

  <div class="banner ${status}">
    ${summary.failed > 0 ? `${summary.failed} of ${summary.total} evals failed` : `All ${summary.total} evals passed`}
  </div>

  <div class="summary">
    <div class="stat"><div class="k">Models</div><div class="v">${shards.length}</div></div>
    <div class="stat"><div class="k">Evals</div><div class="v">${summary.total}</div></div>
    <div class="stat pass"><div class="k">Passed</div><div class="v">${summary.passed}</div></div>
    <div class="stat fail"><div class="k">Failed</div><div class="v">${summary.failed}</div></div>
    <div class="stat"><div class="k">Duration</div><div class="v">${formatDuration(summary.durationMs)}</div></div>
    <div class="stat"><div class="k">Tokens</div><div class="v">${totalTokens.toLocaleString()}</div></div>
  </div>

  ${renderMatrix(shards)}

  <h2>Details</h2>
  ${shards.map(renderModelSection).join("")}
</div>
</body>
</html>`;
}
