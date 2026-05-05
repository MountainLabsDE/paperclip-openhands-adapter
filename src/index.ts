import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  execute,
  sessionCodec,
  listSkills,
  syncSkills,
  testEnvironment,
  listModels,
} from "./server/index.js";

export const type = "openhands_local";
export const label = "OpenHands (local)";

export const DEFAULT_OPENHANDS_LOCAL_MODEL = "openai/mountainlabs-main";

export const models: Array<{ id: string; label: string }> = [
  { id: "openai/mountainlabs-main", label: "mountainlabs-main (default, high quality)" },
  { id: "openai/mountainlabs-main-5", label: "mountainlabs-main-5 (GPT-4.1 level)" },
  { id: "openai/mountainlabs-fast", label: "mountainlabs-fast (speed optimized)" },
  { id: "openai/mountainlabs-free-fast", label: "mountainlabs-free-fast (free tier)" },
  { id: "openai/mountainlabs-4.6v", label: "mountainlabs-4.6v (vision capable)" },
  { id: "openai/mountainlabs-image-free", label: "mountainlabs-image-free (image gen, free)" },
  { id: "openai/Ganjo", label: "Ganjo (custom agent model)" },
];

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    listSkills,
    syncSkills,
    sessionCodec,
    models,
    listModels,
    agentConfigurationDoc,
  };
}

export const agentConfigurationDoc = `# openhands_local agent configuration

Adapter: openhands_local

Use when:
- You want Paperclip to run OpenHands locally as the agent runtime
- You want provider/model routing in OpenHands format (provider/model)
- You want OpenHands session resume across heartbeats via --resume

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenHands CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenHands model id in provider/model format (for example openai/mountainlabs-main)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "openhands"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenHands supports multiple providers and models. Use \`openhands models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`openhands_local\` agents.
- Runs are executed with: openhands --headless --override-with-envs -t "<task>"
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- The adapter uses --override-with-envs to prevent OpenHands from writing settings files.
- Model selection and API configuration are passed via environment variables (LLM_MODEL, LLM_API_KEY, LLM_BASE_URL).
- OpenHands requires both OPENAI_API_KEY and OPENAI_API_BASE environment variables for compatibility.
`;
