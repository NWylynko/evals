/**
 * Runs a dev server inside an eval's workspace so a browser can check what the
 * agent actually built, rather than trusting that a file contains a string.
 *
 * Readiness is detected by reading the server's own output, never by sleeping:
 * a fixed delay is either a flake or wasted time, and the server already tells
 * us when it is listening and on which port.
 */

import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;

export interface WorkspaceDevServer {
  /** Base URL the server is actually listening on, as it reported it. */
  readonly url: string;
  /** Everything the server has written so far — useful when a page 500s. */
  output(): string;
  stop(): Promise<void>;
}

export interface WorkspaceDevServerOptions {
  cwd: string;
  command: string;
  args: string[];
  /** Must capture the base URL in group 1. */
  urlPattern: RegExp;
  /** Server is considered up only once this also matches. */
  readyPattern: RegExp;
  startupTimeoutMs?: number;
}

/**
 * Starts a dev server and resolves once it reports both a URL and readiness.
 *
 * The child runs in its own process group so stop() can take down the whole
 * tree — Next.js spawns workers that survive killing the parent alone and would
 * otherwise hold the port for the rest of the suite.
 */
export function startWorkspaceDevServer(
  options: WorkspaceDevServerOptions,
): Promise<WorkspaceDevServer> {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  return new Promise((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
    });

    let output = "";
    let settled = false;
    let url: string | undefined;

    const stop = async (): Promise<void> => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop();
      rejectPromise(
        new Error(
          `pi eval harness: dev server did not become ready within ${startupTimeoutMs}ms.\n` +
            `command: ${options.command} ${options.args.join(" ")}\ncwd: ${options.cwd}\n` +
            `--- output ---\n${output.slice(-3000)}`,
        ),
      );
    }, startupTimeoutMs);

    const inspect = (chunk: string): void => {
      output += chunk;
      if (settled) return;

      url ??= options.urlPattern.exec(output)?.[1];
      if (!url || !options.readyPattern.test(output)) return;

      settled = true;
      clearTimeout(timer);
      resolvePromise({
        url: url.replace(/\/$/, ""),
        output: () => output,
        async stop() {
          await stop();
        },
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error(`pi eval harness: failed to start dev server: ${error.message}`));
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new Error(
          `pi eval harness: dev server exited (code ${code}) before becoming ready.\n` +
            `--- output ---\n${output.slice(-3000)}`,
        ),
      );
    });
  });
}

/** Next.js prints "- Local: http://localhost:3000" then "✓ Ready in 1.2s". */
export const NEXT_DEV_URL_PATTERN = /(https?:\/\/localhost:\d+)/i;
export const NEXT_DEV_READY_PATTERN = /Ready in|started server on|compiled successfully/i;
