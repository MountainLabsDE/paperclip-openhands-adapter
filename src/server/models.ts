import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * OpenHands v1.15+ removed the `models` CLI subcommand.
 * Model routing is handled entirely by litellm at runtime via the
 * LLM_MODEL environment variable.  Any `provider/model` string that
 * litellm understands is accepted — there is no client-side validation.
 *
 * The adapter therefore exposes a *static* model catalogue (the same
 * list the agent-configuration doc advertises) and trusts the user-
 * configured model string at execution time.
 */

const STATIC_MODELS: readonly AdapterModel[] = [
  { id: "openai/mountainlabs-main", label: "mountainlabs-main (default, high quality)" },
  { id: "openai/mountainlabs-main-5", label: "mountainlabs-main-5 (GPT-4.1 level)" },
  { id: "openai/mountainlabs-fast", label: "mountainlabs-fast (speed optimized)" },
  { id: "openai/mountainlabs-free-fast", label: "mountainlabs-free-fast (free tier)" },
  { id: "openai/mountainlabs-4.6v", label: "mountainlabs-4.6v (vision capable)" },
  { id: "openai/mountainlabs-image-free", label: "mountainlabs-image-free (image gen, free)" },
  { id: "openai/Ganjo", label: "Ganjo (custom agent model)" },
] as const;

/**
 * Return the built-in model list.  These are always available regardless
 * of whether the OpenHands CLI is reachable.
 */
export async function listOpenHandsModels(): Promise<AdapterModel[]> {
  return [...STATIC_MODELS];
}

/**
 * Validate that the configured model is in `provider/model` format.
 *
 * Unlike the previous implementation (which spawned `openhands models` and
 * parsed its stdout), this is a pure string check because OpenHands v1.15+
 * removed the `models` subcommand and relies on litellm for model routing.
 */
export async function ensureOpenHandsModelConfiguredAndAvailable(input: {
  model?: unknown;
}): Promise<AdapterModel[]> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) {
    throw new Error(
      "OpenHands requires `adapterConfig.model` in provider/model format (e.g. openai/mountainlabs-main).",
    );
  }
  if (!model.includes("/")) {
    throw new Error(
      `Configured model "${model}" is not in provider/model format. ` +
      `Expected something like "openai/mountainlabs-main".`,
    );
  }
  return [...STATIC_MODELS];
}

/**
 * Discover models (kept for backward compatibility with the ServerAdapterModule interface).
 * Returns the static catalogue — no subprocess spawning.
 */
export async function discoverOpenHandsModels(): Promise<AdapterModel[]> {
  return [...STATIC_MODELS];
}

/** Cached version — returns immediately, no cache invalidation needed for static data. */
export async function discoverOpenHandsModelsCached(): Promise<AdapterModel[]> {
  return [...STATIC_MODELS];
}

/** No-op — kept for test compatibility. */
export function resetOpenHandsModelsCacheForTests(): void {
  // nothing to clear
}
