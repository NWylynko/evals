/**
 * Parsing for pi's `--mode json` output: one JSON object per line, described in
 * the pi docs under "JSON Event Stream Mode".
 */

export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export interface PiAssistantMessage {
  role: "assistant";
  content: PiContentBlock[];
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  provider?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
}

export interface PiEvent {
  type: string;
  message?: { role?: string } & Partial<PiAssistantMessage>;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface PiToolCall {
  id: string;
  name: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

/** Lines that are not JSON (stray provider warnings) are skipped, not fatal. */
export function parsePiEventStream(stdout: string): PiEvent[] {
  const events: PiEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      continue;
    }
  }
  return events;
}

export function collectAssistantMessages(events: PiEvent[]): PiAssistantMessage[] {
  return events
    .filter((event) => event.type === "message_end")
    .map((event) => event.message)
    .filter((message): message is PiAssistantMessage => message?.role === "assistant");
}

/**
 * Concatenated text of the last assistant message, with thinking blocks
 * dropped — this is what a user would see as the answer.
 */
export function extractFinalText(messages: PiAssistantMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  return last.content
    .filter((block): block is Extract<PiContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * The provider/model error behind a failed run, if any.
 *
 * pi reports these as an assistant message with `stopReason: "error"` and the
 * detail in `errorMessage`. Surfacing it is the difference between a useful
 * failure and "expected 'error' to be 'stop'".
 */
export function extractErrorMessage(messages: PiAssistantMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.errorMessage) return message.errorMessage;
  }
  return undefined;
}

export interface PiUsageTotals {
  input: number;
  output: number;
  totalTokens: number;
}

/** Token usage summed across every assistant message in a run. */
export function sumPiUsage(messages: PiAssistantMessage[]): PiUsageTotals {
  return messages.reduce<PiUsageTotals>(
    (totals, message) => ({
      input: totals.input + (message.usage?.input ?? 0),
      output: totals.output + (message.usage?.output ?? 0),
      totalTokens: totals.totalTokens + (message.usage?.totalTokens ?? 0),
    }),
    { input: 0, output: 0, totalTokens: 0 },
  );
}

/** Pairs each tool_execution_start with its matching tool_execution_end. */
export function collectToolCalls(events: PiEvent[]): PiToolCall[] {
  const started = new Map<string, { name: string; args: unknown }>();
  const calls: PiToolCall[] = [];

  for (const event of events) {
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      started.set(event.toolCallId, { name: event.toolName ?? "unknown", args: event.args });
      continue;
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const start = started.get(event.toolCallId);
      calls.push({
        id: event.toolCallId,
        name: event.toolName ?? start?.name ?? "unknown",
        args: start?.args,
        result: event.result,
        isError: event.isError === true,
      });
    }
  }
  return calls;
}
