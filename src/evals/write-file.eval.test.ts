import { describe, expect, it } from "vitest";

import { createPiHarness } from "../pi-harness/index.ts";

describe("pi agent: write a file", () => {
  it("creates hello.txt with the requested content in its workspace", async () => {
    // No model pinned: the eval runs against whichever model the matrix
    // runner has loaded for this pass.
    const harness = await createPiHarness();

    const run = await harness.runPiAgent(
      "Create a file named hello.txt in the current directory containing exactly: Hello, World!",
    );

    // Asserted first: on a provider/model error this prints the actual cause,
    // where stopReason alone only ever says "error".
    expect(run.errorMessage).toBeUndefined();
    expect(run.stopReason).toBe("stop");
    expect(run.toolNames).toContain("write");

    const hello = await harness.readWorkspaceFile("hello.txt");
    expect(hello.trim()).toBe("Hello, World!");
  });
});