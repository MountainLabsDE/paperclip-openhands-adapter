/**
 * Self-contained UI parser for OpenHands adapter.
 *
 * Runs inside a sandboxed Web Worker with zero runtime dependencies.
 * Exports: parseStdoutLine(line, ts) -> TranscriptEntry[]
 *
 * TranscriptEntry kinds: "assistant" | "user" | "tool_call" | "tool_result"
 *   | "system" | "stdout" | "stderr" | "thinking" | "result"
 */

"use strict";

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value, fallback) {
  return typeof value === "string" ? value : (fallback || "");
}

function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : (fallback || 0);
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(function (item) { return typeof item === "object" && item !== null; })
    .map(function (item) { return asString(item.text, "").trim(); })
    .filter(Boolean)
    .join("\n");
}

function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\[\?[0-9]*[lh]/g, "")
    .replace(/\x1b\[[A-HJKST]/g, "");
}

function extractJsonObject(text) {
  var start = text.indexOf("{");
  if (start === -1) return null;
  var depth = 0, inString = false, escape = false;
  for (var i = start; i < text.length; i++) {
    var ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return safeJsonParse(text.slice(start, i + 1));
    }
  }
  return null;
}

function errorText(value) {
  if (typeof value === "string") return value;
  var rec = asRecord(value);
  if (!rec) return "";
  var data = asRecord(rec.data);
  var msg = asString(rec.message) || asString(data && data.message) || asString(rec.name) || "";
  if (msg) return msg;
  try { return JSON.stringify(rec); } catch { return ""; }
}

// ── Tool use parsing ─────────────────────────────────────────────────────────

function parseToolUse(parsed, ts) {
  var part = asRecord(parsed.part);
  if (!part) return [{ kind: "system", ts: ts, text: "tool event" }];

  var toolName = asString(part.tool, "tool");
  var state = asRecord(part.state) || asRecord(part.status);
  var input = (state && state.input) || part.input || {};
  var callEntry = {
    kind: "tool_call",
    ts: ts,
    name: toolName,
    toolUseId: asString(part.callID) || asString(part.id) || undefined,
    input: input,
  };

  var status = asString(state && state.status) || asString(part.status);
  if (status !== "completed" && status !== "error" && status !== "failed") return [callEntry];

  var rawOutput =
    asString(state && state.output) ||
    asString(state && state.error) ||
    asString(part.output) ||
    asString(part.error) ||
    asString(part.title) ||
    (toolName + " " + status);

  var metadata = asRecord(state && state.metadata) || asRecord(part.metadata);
  var headerParts = ["status: " + status];
  if (metadata) {
    for (var key in metadata) {
      if (metadata.hasOwnProperty(key) && metadata[key] !== undefined && metadata[key] !== null) {
        headerParts.push(key + ": " + metadata[key]);
      }
    }
  }
  var content = headerParts.join("\n") + "\n\n" + rawOutput;
  content = content.trim();

  return [
    callEntry,
    {
      kind: "tool_result",
      ts: ts,
      toolUseId: asString(part.callID) || asString(part.id, toolName),
      content: content,
      isError: status === "error" || status === "failed",
    },
  ];
}

// ── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single line of OpenHands `--json` output.
 *
 * @param {string} line  - Raw stdout line.
 * @param {string} ts    - ISO timestamp string.
 * @returns {Array} TranscriptEntry[]
 */
function parseStdoutLine(line, ts) {
  var cleaned = stripAnsi(line);

  // Skip separator / hint lines
  if (/^--JSON Event--\s*$/.test(cleaned)) return [];
  if (/^Conversation ID:/i.test(cleaned) || /^Hint:/i.test(cleaned) || /^Goodbye/i.test(cleaned)) {
    return [{ kind: "system", ts: ts, text: cleaned.trim() }];
  }

  // Try JSON extraction
  var parsed = asRecord(extractJsonObject(cleaned));
  if (!parsed) {
    var trimmed = cleaned.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts: ts, text: trimmed }];
  }

  // ── New --json format: events use a `kind` field ──
  var kind = asString(parsed.kind, "").trim();

  if (kind === "MessageEvent") {
    var source = asString(parsed.source, "").trim();
    var llmMessage = asRecord(parsed.llm_message);
    if (llmMessage) {
      var text = extractContentText(llmMessage.content).trim();
      if (!text) return [];
      return [{ kind: source === "agent" ? "assistant" : "user", ts: ts, text: text }];
    }
    text = asString(parsed.message) || asString(parsed.text) || asString(parsed.content);
    text = text.trim();
    if (!text) return [];
    return [{ kind: "assistant", ts: ts, text: text }];
  }

  if (kind === "ObservationEvent") {
    var observation = asRecord(parsed.observation);
    if (observation) {
      var isError = asString(observation.is_error) === "true" || observation.is_error === true;
      if (isError) {
        text = extractContentText(observation.content).trim();
        if (text) return [{ kind: "stderr", ts: ts, text: text }];
      }
      var toolName = asString(observation.tool_name, "");
      if (toolName) {
        text = extractContentText(observation.content).trim();
        return [{
          kind: "tool_result",
          ts: ts,
          toolUseId: asString(observation.tool_call_id, toolName),
          content: text || (toolName + " completed"),
          isError: isError,
        }];
      }
    }
    return [];
  }

  if (kind === "ActionEvent") {
    var action = asRecord(parsed.action);
    if (action) {
      var actionType = asString(action.action_type, "").trim();
      if (actionType === "run" || actionType === "run_ipython") {
        var command = asString(action.command, "");
        return [{ kind: "tool_call", ts: ts, name: actionType, input: { command: command } }];
      }
      if (actionType === "message") {
        text = extractContentText(action.content).trim();
        if (text) return [{ kind: "assistant", ts: ts, text: text }];
      }
    }
    return [];
  }

  // ── Legacy format: events use a `type` field ──
  var type = asString(parsed.type) || asString(parsed.event_type);

  if (type === "message" || type === "thinking" || type === "text") {
    text = asString(parsed.message) || asString(parsed.text) || asString(parsed.content);
    text = text.trim();
    if (!text) return [];
    return [{ kind: type === "thinking" ? "thinking" : "assistant", ts: ts, text: text }];
  }

  if (type === "reasoning") {
    var part = asRecord(parsed.part);
    text = asString(part && part.text) || asString(parsed.text);
    text = text.trim();
    if (!text) return [];
    return [{ kind: "thinking", ts: ts, text: text }];
  }

  if (type === "tool_use" || type === "tool_call") {
    return parseToolUse(parsed, ts);
  }

  if (type === "step_start") {
    var sessionId = asString(parsed.sessionId) || asString(parsed.sessionID);
    return [{ kind: "system", ts: ts, text: "step started" + (sessionId ? " (" + sessionId + ")" : "") }];
  }

  if (type === "step_completion" || type === "step_finish" || type === "completion") {
    var part = asRecord(parsed.part);
    var tokens = asRecord(part && part.tokens) || asRecord(parsed.usage);
    var cache = asRecord(tokens && tokens.cache) || asRecord(tokens && tokens.cached);
    var reason = asString(part && part.reason, "step") || asString(parsed.status, "step");
    var output = asNumber(tokens && tokens.output, 0) || asNumber(tokens && tokens.output_tokens, 0);
    var input = asNumber(tokens && tokens.input, 0) || asNumber(tokens && tokens.input_tokens, 0);
    var cached = asNumber(cache && cache.read, 0) || asNumber(cache && cache.cached_tokens, 0) || asNumber(tokens && tokens.cached_input_tokens, 0);
    var cost = asNumber(part && part.cost, 0) || asNumber(parsed.cost, 0) || asNumber(parsed.cost_usd, 0);
    return [{
      kind: "result",
      ts: ts,
      text: reason,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      costUsd: cost,
      subtype: reason,
      isError: false,
      errors: [],
    }];
  }

  if (type === "error" || type === "failure") {
    text = errorText(parsed.error || parsed.message || parsed.reason);
    return [{ kind: "stderr", ts: ts, text: text || line }];
  }

  return [{ kind: "stdout", ts: ts, text: line }];
}

// Export for CJS-style evaluation (used by sandboxed worker's new Function())
if (typeof exports !== "undefined") {
  exports.parseStdoutLine = parseStdoutLine;
}
