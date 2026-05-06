import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenHandsUnknownSessionError, parseOpenHandsJsonl } from "./parse.js";
import { ensureOpenHandsModelConfiguredAndAvailable } from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve an adapter config env value that may be:
 * - A plain string → return as-is
 * - A secret_ref object { type: "secret_ref", secretId: "..." } → fetch the
 *   resolved value from the Paperclip secrets API at runtime.
 * - A plain-value object { type: "plain", value: "..." } → extract .value
 * - Anything else → return empty string.
 *
 * Paperclip stores env values as secret_ref or plain objects but doesn't
 * always resolve them before passing config to third-party adapters.
 * This helper ensures the adapter gets actual string values.
 */
async function resolveEnvValue(rawValue: unknown): Promise<string> {
  if (typeof rawValue === "string") return rawValue;
  if (
    typeof rawValue === "object" &&
    rawValue !== null
  ) {
    const obj = rawValue as Record<string, unknown>;
    // Handle { type: "plain", value: "..." }
    if (obj.type === "plain" && typeof obj.value === "string") {
      return obj.value;
    }
    // Handle { type: "secret_ref", secretId: "..." }
    if (obj.type === "secret_ref" && typeof obj.secretId === "string") {
      const apiUrl = process.env.PAPERCLIP_API_URL ?? process.env.PAPERCLIP_RUNTIME_API_URL ?? "";
      const apiKey = process.env.PAPERCLIP_API_KEY ?? "";
      if (apiUrl && apiKey) {
        try {
          const res = await fetch(
            `${apiUrl}/secrets/${obj.secretId}/resolve`,
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (res.ok) {
            const data = (await res.json()) as { value?: string };
            if (typeof data.value === "string") return data.value;
          }
        } catch {
          // Fall through to empty string
        }
      }
      return "";
    }
  }
  return "";
}

/**
 * Detect whether the child process was terminated by an external signal
 * (SIGTERM / SIGHUP) sent by the Paperclip supervisor to cancel a run.
 *
 * When Paperclip cancels a run it sends SIGTERM to the process group.
 * Hermes' Python signal handler catches it and raises `KeyboardInterrupt`,
 * which causes the process to exit with code 1 and a traceback in stderr.
 * We detect this pattern so we can treat the exit as a clean cancellation
 * rather than a crash.
 */
function isSignalCancelled(
  exitCode: number | null,
  signal: string | null,
  stderr: string,
): boolean {
  if (signal === "SIGTERM" || signal === "SIGHUP") return true;
  // Python raises KeyboardInterrupt when its SIGTERM/SIGHUP handler fires.
  // The process exits with code 1 (or sometimes 130 = 128+SIGINT) and the
  // traceback is written to stderr.  Match the common patterns.
  if (exitCode !== null && exitCode !== 0) {
    // Look for the classic Python traceback ending in KeyboardInterrupt
    // caused by _signal_handler_q or similar signal-handler frames.
    if (/KeyboardInterrupt\b/.test(stderr)) return true;
  }
  return false;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenHandsBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

function openHandsSkillsHome(): string {
  return path.join(os.homedir(), ".openhands", "skills");
}

async function ensureOpenHandsSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const skillsHome = openHandsSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenHands skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenHands skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenHands skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/**
 * Build a prompt section that teaches the OpenHands agent how to interact
 * with the Paperclip API (post comments, update issue status, etc.).
 *
 * OpenHands agents run in a sandbox and need explicit instructions on how to
 * use the Paperclip API.  The environment variables PAPERCLIP_API_URL and
 * PAPERCLIP_API_KEY are already injected by the adapter, but the prompt must
 * tell the agent how to use them.
 */
function buildPaperclipApiInstructions(ctx: {
  wakeTaskId: string | null;
  companyId: string;
  agentId: string;
}): string {
  const lines = [
    "## Paperclip API",
    "",
    "You have access to the Paperclip API for issue management. Use it to post progress comments, update issue status, and create child issues.",
    "",
    "### Environment variables (already set in your environment)",
    "- `PAPERCLIP_API_URL` – API base URL (e.g. http://localhost:3100/api)",
    "- `PAPERCLIP_API_KEY` – Bearer token for authorization",
    `- PAPERCLIP_TASK_ID – current issue/task ID${ctx.wakeTaskId ? ` (${ctx.wakeTaskId})` : ""}`,
    "",
    "### Common API patterns",
    "",
    "**Post a comment on the current issue:**",
    "```bash",
    'curl -s -X POST "$PAPERCLIP_API_URL/issues/$PAPERCLIP_TASK_ID/comments" \\',
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"body": "Your progress update here"}\'',
    "```",
    "",
    "**Update issue status:**",
    "```bash",
    'curl -s -X PATCH "$PAPERCLIP_API_URL/issues/$PAPERCLIP_TASK_ID" \\',
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"status": "done"}\'   # or: "in_progress", "todo", "blocked"',
    "```",
    "",
    "**Create a child issue:**",
    "```bash",
    'curl -s -X POST "$PAPERCLIP_API_URL/companies/' + ctx.companyId + '/issues" \\',
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"title": "Child task title", "parentId": "' + (ctx.wakeTaskId ?? "") + '", "priority": "high"}\'',
    "```",
    "",
    "**Mark yourself as working on an issue:**",
    "```bash",
    'curl -s -X PATCH "$PAPERCLIP_API_URL/issues/$PAPERCLIP_TASK_ID" \\',
    '  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"status": "in_progress", "assigneeAgentId": "' + ctx.agentId + '"}\'',
    "```",
    "",
    "### MANDATORY rules (you MUST follow these)",
    "- **MANDATORY**: Post a comment on the current issue BEFORE you start working (your plan).",
    "- **MANDATORY**: Post a comment when you complete work or make significant progress.",
    "- **MANDATORY**: Update the issue status to `done` when finished, `in_progress` when starting, `blocked` if you cannot proceed.",
    "- **MANDATORY**: Include a summary of what you did in your completion comment.",
    "- Use `$PAPERCLIP_API_URL` and `$PAPERCLIP_API_KEY` environment variables (they are already set in your shell).",
    "- Use `run_bash` to execute the curl commands shown above.",
  ];

  return lines.join("\n");
}

/**
 * Build a closing reminder that the agent must post a completion comment.
 * This is appended at the very end of the prompt as a final nudge.
 */
function buildPaperclipClosingReminder(): string {
  return [
    "",
    "---",
    "**REMINDER**: Before finishing, you MUST post a completion comment on the current issue via the Paperclip API (see the Paperclip API section above for curl commands). Also update the issue status to `done` if the task is complete. Failure to do so means your work will not be visible to your team.",
    "",
  ].join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  // Sanitize the command: strip deprecated OpenHands subcommands (e.g. "chat")
  // that were valid in older versions but removed in newer CLI versions.
  // OpenHands >= 0.15 no longer supports positional subcommands like `chat`.
  const rawCommand = asString(config.command, "openhands");
  const DEPRECATED_OPENHANDS_SUBCOMMANDS = ["chat", "code", "run", "ask"];
  const commandParts = rawCommand.trim().split(/\s+/);
  const baseCommand = commandParts[0] || "openhands";
  const trailingParts = commandParts.slice(1);
  const strippedSubcommands: string[] = [];
  const cleanTrailing = trailingParts.filter((part) => {
    if (DEPRECATED_OPENHANDS_SUBCOMMANDS.includes(part)) {
      strippedSubcommands.push(part);
      return false;
    }
    return true;
  });
  const command = [baseCommand, ...cleanTrailing].join(" ") || "openhands";
  if (strippedSubcommands.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Warning: stripped deprecated OpenHands subcommand(s) "${strippedSubcommands.join(", ")}" from command config. ` +
        `Modern OpenHands CLI does not use positional subcommands. Using "${command}" instead.\n`,
    );
  }
  const model = asString(config.model, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const openHandsSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenHandsSkillNames = resolvePaperclipDesiredSkillNames(config, openHandsSkillEntries);
  await ensureOpenHandsSkillsInjected(
    onLog,
    openHandsSkillEntries,
    desiredOpenHandsSkillNames,
  );

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Inject the Paperclip API token so the agent can call back to update issue status
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Fallback: if the runtime didn't provide authToken (some Paperclip versions
  // don't pass it to local adapters), capture PAPERCLIP_API_KEY from the
  // server's own process.env before sanitizeInheritedPaperclipEnv strips it.
  if (!env.PAPERCLIP_API_KEY && typeof process.env.PAPERCLIP_API_KEY === "string" && process.env.PAPERCLIP_API_KEY.trim()) {
    env.PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
  }

  // Set LLM environment variables for OpenHands
  if (model) {
    env.LLM_MODEL = model;
  }
  
  // OpenHands requires both OPENAI_API_KEY and OPENAI_API_BASE for compatibility
  // LLM_API_KEY and LLM_BASE_URL are the preferred way, but we set both
  const llmApiKey = await resolveEnvValue(envConfig.LLM_API_KEY ?? envConfig.OPENAI_API_KEY);
  const llmBaseUrl = await resolveEnvValue(envConfig.LLM_BASE_URL ?? envConfig.OPENAI_API_BASE);
  
  if (llmApiKey) {
    env.LLM_API_KEY = llmApiKey;
    env.OPENAI_API_KEY = llmApiKey;
  }
  
  if (llmBaseUrl) {
    env.LLM_BASE_URL = llmBaseUrl;
    env.OPENAI_API_BASE = llmBaseUrl;
  }

  // Optional GitHub token for better repository operations
  const githubToken = await resolveEnvValue(envConfig.GITHUB_TOKEN);
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
  }

  const timeoutSec = asNumber(config.timeoutSec, 3600);
  const graceSec = asNumber(config.graceSec, 10);
  const extraArgs = asStringArray(config.extraArgs);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] OpenHands session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes = (() => {
    const notes: string[] = [];
    if (!resolvedInstructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(
      `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
    return notes;
  })();

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipApiInstructions = buildPaperclipApiInstructions({
    wakeTaskId,
    companyId: agent.companyId,
    agentId: agent.id,
  });
  const paperclipClosingReminder = buildPaperclipClosingReminder();
  const prompt = joinPromptSections([
    instructionsPrefix,
    paperclipApiInstructions,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
    paperclipClosingReminder,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--headless", "--json", "--exit-without-confirmation", "--override-with-envs", "-t", prompt];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "openhands_local",
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      stdin: "",
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseOpenHandsJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parseOpenHandsJsonl>;
    },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const modelId = model || null;

    // When the Paperclip supervisor cancels a run it sends SIGTERM to the
    // process group.  Hermes catches the signal and raises KeyboardInterrupt,
    // producing a non-zero exit code and a traceback in stderr.  Detect this
    // pattern and return a clean "cancelled" result so the run is not marked
    // as a crash.  Preserve any partial session data captured before the
    // signal arrived.
    if (isSignalCancelled(rawExitCode, attempt.proc.signal, attempt.proc.stderr)) {
      return {
        exitCode: 0,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenHandsBiller(env, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary || undefined,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    }

    const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `OpenHands exited with code ${synthesizedExitCode ?? -1}`;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: parseModelProvider(modelId),
      biller: resolveOpenHandsBiller(env, parseModelProvider(modelId)),
      model: modelId,
      billingType: "unknown",
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  const initialFailed =
    !initial.proc.timedOut &&
    !isSignalCancelled(initial.proc.exitCode, initial.proc.signal, initial.proc.stderr) &&
    ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
  if (
    sessionId &&
    initialFailed &&
    isOpenHandsUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] OpenHands session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
