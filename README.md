# Paperclip OpenHands Adapter

A Paperclip adapter that enables AI agents to execute code and interact with development environments using [OpenHands](https://github.com/All-Hands-AI/OpenHands) (formerly OpenDevin).

## Overview

This adapter allows Paperclip-managed AI agents to use OpenHands as their execution runtime. Agents receive tasks through Paperclip, execute them using OpenHands' sandbox environment, and report results back.

## Features

- **Server Adapter**: Full bidirectional communication with OpenHands CLI
- **UI Parser**: Parses OpenHands output format for Paperclip's UI
- **CLI Support**: Command-line interface for testing and debugging
- **Custom Model Configuration**: Supports configurable LLM models via provider/model format
- **Skill Integration**: Loads Paperclip skills into agent context

## Installation

### As a Paperclip Plugin

```bash
# Build the adapter
npm run build

# Pack as tgz
npm pack

# Install in Paperclip adapter-plugins directory
cd /path/to/paperclip/adapter-plugins
pnpm add ./paperclipai-adapter-openhands-local-0.1.0.tgz
```

### From Source

```bash
git clone https://github.com/MountainLabsDE/paperclip-openhands-adapter.git
cd paperclip-openhands-adapter
npm install
npm run build
```

## Configuration

### Adapter Config (in Paperclip agent settings)

```json
{
  "type": "openhands_local",
  "model": "openai/mountainlabs-main",
  "cwd": "/path/to/workspace",
  "instructionsFilePath": "/path/to/AGENTS.md",
  "command": "openhands",
  "extraArgs": []
}
```

### Required Environment Variables

- `PAPERCLIP_API_KEY` - Paperclip API authentication key
- `OPENAI_API_KEY` or equivalent for the configured LLM provider

### Supported Models

| Model ID | Description |
|----------|-------------|
| `openai/mountainlabs-main` | Default, high quality |
| `openai/mountainlabs-main-5` | GPT-4.1 level |
| `openai/mountainlabs-fast` | Speed optimized |
| `openai/mountainlabs-free-fast` | Free tier |
| `openai/mountainlabs-4.6v` | Vision capable |
| `openai/mountainlabs-image-free` | Image generation, free |
| `openai/Ganjo` | Custom agent model |

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Type check without building
npm run typecheck

# Clean build artifacts
npm run clean
```

## Project Structure

```
src/
  index.ts          # Adapter entry point, model configuration
  cli/              # CLI interface for testing
    index.ts
    format-event.ts
  server/           # Server adapter (bidirectional communication)
    index.ts        # Server adapter module
    execute.ts      # Process execution & management
    parse.ts        # Output parsing
    models.ts       # Runtime config types
    runtime-config.ts
    skills.ts       # Paperclip skill integration
    test.ts         # Test utilities
  ui/               # UI integration
    index.ts
    build-config.ts
    parse-stdout.ts
    ui-parser.js    # UI output parser
```

## Architecture

The adapter implements Paperclip's `ServerAdapterModule` interface:

1. **Paperclip** sends run requests to the adapter
2. **Adapter** spawns OpenHands CLI with the appropriate model and prompt
3. **OpenHands** executes in its sandbox environment
4. **Adapter** parses OpenHands output and streams events back to Paperclip
5. **Paperclip** processes results and updates issue state

## License

MIT
