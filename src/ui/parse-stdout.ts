import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Extract text from an OpenHands llm_message.content array. */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => asString(item.text, "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Strip ANSI escape sequences from a string. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\[\?[0-9]*[lh]/g, "")
    .replace(/\x1b\[[A-HJKST]/g, "");
}

/**
 * Extract a balanced JSON object from a line that may contain trailing noise.
 */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return safeJsonParse(text.slice(start, i + 1));
      }
    }
  }
  return null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const msg =
    asString(rec.message) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function parseToolUse(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const part = asRecord(parsed.part);
  if (!part) return [{ kind: "system", ts, text: "tool event" }];

  const toolName = asString(part.tool, "tool");
  const state = asRecord(part.state) || asRecord(part.status);
  const input = state?.input ?? part?.input ?? {};
  const callEntry: TranscriptEntry = {
    kind: "tool_call",
    ts,
    name: toolName,
    toolUseId: asString(part.callID) || asString(part.id) || undefined,
    input,
  };

  const status = asString(state?.status) || asString(part.status);
  if (status !== "completed" && status !== "error" && status !== "failed") return [callEntry];

  const rawOutput =
    asString(state?.output) ||
    asString(state?.error) ||
    asString(part.output) ||
    asString(part.error) ||
    asString(part.title) ||
    `${toolName} ${status}`;

  const metadata = asRecord(state?.metadata) || asRecord(part.metadata);
  const headerParts: string[] = [`status: ${status}`];
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null) headerParts.push(`${key}: ${value}`);
    }
  }
  const content = `${headerParts.join("\n")}\n\n${rawOutput}`.trim();

  return [
    callEntry,
    {
      kind: "tool_result",
      ts,
      toolUseId: asString(part.callID) || asString(part.id, toolName),
      content,
      isError: status === "error" || status === "failed",
    },
  ];
}

/**
 * Parse a single line of OpenHands `--json` output.
 *
 * With `--json`, OpenHands emits `--JSON Event--` marker lines followed by
 * JSON event objects.  The JSON objects use a `kind` field (e.g. "MessageEvent",
 * "ObservationEvent") rather than the old `type` field.  We handle both formats.
 */
export function parseOpenHandsStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const cleaned = stripAnsi(line);

  // Skip the --JSON Event-- separator marker lines
  if (/^--JSON Event--\s*$/.test(cleaned)) {
    return [];
  }

  // Skip "Conversation ID:" and hint lines at the end
  if (/^Conversation ID:/i.test(cleaned) || /^Hint:/i.test(cleaned) || /^Goodbye/i.test(cleaned)) {
    return [{ kind: "system", ts, text: cleaned.trim() }];
  }

  // Try extracting a JSON object (handles trailing text after JSON)
  const parsed = asRecord(extractJsonObject(cleaned));
  if (!parsed) {
    // Not JSON — likely a human-readable status line like "Agent is working"
    const trimmed = cleaned.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  // --- New --json format: events have a `kind` field ---
  const kind = asString(parsed.kind, "").trim();

  if (kind === "MessageEvent") {
    const source = asString(parsed.source, "").trim();
    const llmMessage = asRecord(parsed.llm_message);
    if (llmMessage) {
      const text = extractContentText(llmMessage.content).trim();
      if (!text) return [];
      const isAgent = source === "agent";
      return [{ kind: isAgent ? "assistant" : "user", ts, text }];
    }
    // Fallback to legacy fields
    const text = asString(parsed.message) || asString(parsed.text) || asString(parsed.content);
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ kind: "assistant", ts, text: trimmed }];
  }

  if (kind === "ObservationEvent") {
    const observation = asRecord(parsed.observation);
    if (observation) {
      const isError = asString(observation.is_error) === "true" || observation.is_error === true;
      if (isError) {
        const text = extractContentText(observation.content).trim();
        if (text) return [{ kind: "stderr", ts, text }];
      }
      // Tool results come as ObservationEvent
      const toolName = asString(observation.tool_name, "");
      if (toolName) {
        const text = extractContentText(observation.content).trim();
        return [{
          kind: "tool_result",
          ts,
          toolUseId: asString(observation.tool_call_id, toolName),
          content: text || `${toolName} completed`,
          isError,
        }];
      }
    }
    return [];
  }

  if (kind === "ActionEvent") {
    const action = asRecord(parsed.action);
    if (action) {
      const actionType = asString(action.action_type, "").trim();
      if (actionType === "run" || actionType === "run_ipython") {
        const command = asString(action.command, "");
        return [{
          kind: "tool_call",
          ts,
          name: actionType,
          input: { command },
        }];
      }
      if (actionType === "message") {
        const text = extractContentText(action.content).trim();
        if (text) return [{ kind: "assistant", ts, text }];
      }
    }
    return [];
  }

  // --- Legacy format: events have a `type` field ---
  const type = asString(parsed.type) || asString(parsed.event_type);

  // Parse message/thinking text
  if (type === "message" || type === "thinking" || type === "text") {
    const text = asString(parsed.message) || asString(parsed.text) || asString(parsed.content);
    const trimmed = text.trim();
    if (!trimmed) return [];
    const entryKind = type === "thinking" ? "thinking" : "assistant";
    return [{ kind: entryKind, ts, text: trimmed }];
  }

  // Parse reasoning
  if (type === "reasoning") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text) || asString(parsed.text);
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ kind: "thinking", ts, text: trimmed }];
  }

  // Parse tool use
  if (type === "tool_use" || type === "tool_call") {
    return parseToolUse(parsed, ts);
  }

  // Parse step start
  if (type === "step_start") {
    const sessionId = asString(parsed.sessionId) || asString(parsed.sessionID);
    return [
      {
        kind: "system",
        ts,
        text: `step started${sessionId ? ` (${sessionId})` : ""}`,
      },
    ];
  }

  // Parse step completion
  if (type === "step_completion" || type === "step_finish" || type === "completion") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens) || asRecord(parsed.usage);
    const cache = asRecord(tokens?.cache) || asRecord(tokens?.cached);
    const reason = asString(part?.reason, "step") || asString(parsed.status, "step");
    const output = asNumber(tokens?.output, 0) || asNumber(tokens?.output_tokens, 0);
    const input = asNumber(tokens?.input, 0) || asNumber(tokens?.input_tokens, 0);
    const cached = asNumber(cache?.read, 0) || asNumber(cache?.cached_tokens, 0) || asNumber(tokens?.cached_input_tokens, 0);
    const cost = asNumber(part?.cost, 0) || asNumber(parsed.cost, 0) || asNumber(parsed.cost_usd, 0);
    return [
      {
        kind: "result",
        ts,
        text: reason,
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cached,
        costUsd: cost,
        subtype: reason,
        isError: false,
        errors: [],
      },
    ];
  }

  // Parse error
  if (type === "error" || type === "failure") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.reason);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
