import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

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
 * Extract a balanced JSON object from text that may contain trailing noise.
 *
 * OpenHands `--json` output includes human-readable text after each JSON event
 * (e.g. "Agent is working").  This function finds the first `{` and walks the
 * string tracking brace depth to find where the JSON object ends.
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
        return parseJson(text.slice(start, i + 1));
      }
    }
  }
  return null;
}

/**
 * Parse OpenHands `--json` output.
 *
 * The `--json` flag emits `--JSON Event--` markers followed by multi-line JSON
 * objects, interspersed with human-readable status text like "Agent is working".
 * After all events the CLI prints a "Conversation ID: <uuid>" line.
 */
export function parseOpenHandsJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  // Extract Conversation ID from the tail of the output (e.g. "Conversation ID: abc123def456")
  // OpenHands uses 32-char hex IDs without hyphens, but also match UUID format just in case
  const convIdMatch = stdout.match(/Conversation ID:\s*([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{32})/i);
  if (convIdMatch) sessionId = convIdMatch[1];

  // Strip ANSI codes so JSON markers/braces are clean
  const cleaned = stripAnsi(stdout);

  // Split on the `--JSON Event--` separator and parse each block
  const blocks = cleaned.split(/--JSON Event--\s*/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Each block may contain JSON followed by status text; extract just the JSON
    const event = extractJsonObject(trimmed);
    if (!event || typeof event !== "object") continue;

    const kind = asString((event as Record<string, unknown>).kind, "").trim();

    // --- Agent messages (assistant replies) ---
    if (kind === "MessageEvent") {
      const source = asString((event as Record<string, unknown>).source, "").trim();
      const llmMessage = parseObject((event as Record<string, unknown>).llm_message);
      if (llmMessage && source === "agent") {
        const text = extractContentText(llmMessage.content).trim();
        if (text) messages.push(text);
      }
      continue;
    }

    // --- Observation errors ---
    if (kind === "ObservationEvent") {
      const observation = parseObject((event as Record<string, unknown>).observation);
      if (observation) {
        const isError = asString(observation.is_error, "") === "true" ||
          observation.is_error === true;
        if (isError) {
          const text = extractContentText(observation.content).trim();
          if (text) errors.push(text);
        }
      }
      continue;
    }

    // --- Legacy / fallback: step_completion with token usage ---
    const type = asString((event as Record<string, unknown>).type, "") ||
      asString((event as Record<string, unknown>).event_type, "");
    if (type === "step_completion" || type === "step_finish" || type === "completion") {
      const tokens = parseObject((event as Record<string, unknown>).tokens) ||
        parseObject((event as Record<string, unknown>).usage);
      const cache = parseObject(tokens.cache) || parseObject(tokens.cached);
      usage.inputTokens += asNumber(tokens.input, 0) || asNumber(tokens.input_tokens, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0) || asNumber(cache.cached_tokens, 0) || asNumber(tokens.cached_input_tokens, 0);
      usage.outputTokens += asNumber(tokens.output, 0) || asNumber(tokens.output_tokens, 0);
      costUsd += asNumber((event as Record<string, unknown>).cost, 0) ||
        asNumber((event as Record<string, unknown>).cost_usd, 0);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

export function isOpenHandsUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session|session.*does not exist/i.test(
    haystack,
  );
}
