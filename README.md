# 10TimesDev — AI Agent Orchestrator

Run multiple AI coding agents in parallel, each in its own isolated workspace. Manage tasks, review code, and merge — all from a single dashboard.

**[Documentation](https://10times.dev/docs/)** · **[Website](https://10times.dev)** · **[Buy me a coffee ☕](https://buymeacoffee.com/radzisz)**

---

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ | |
| pnpm | 9+ | `npm install -g pnpm` |
| Docker | 24+ | For isolated agent workspaces |
| Git | 2.30+ | |

You also need access to at least one AI provider:

- **Claude Code** with a Claude Pro/Max subscription (easiest — just `claude login`) or an Anthropic API key
- **Aider** with Anthropic, OpenAI, or **Ollama** (local LLM, free)

### Install & Run

```bash
git clone https://github.com/radzisz/agentOrchestrator.git
cd agentOrchestrator
pnpm install
pnpm dev
```

Open **http://localhost:3000** in your browser.

### First Task

1. Go to **Projects** → **Add Project** → select a Git repository folder
2. Open the project → **Tasks** tab → **New Task** → describe what you want
3. An agent spawns automatically — watch it work in the **Agents** tab
4. When it finishes, review the diff → **Merge** or **Reject**

> Full walkthrough: [10times.dev/docs/#quick-start](https://10times.dev/docs/#quick-start)

## Architecture

pnpm monorepo:

```
apps/web/                Next.js app (UI + API)
packages/
  contracts/             Abstract base classes (BaseTracker, BaseSCMProvider, BaseAIProvider)
  core/                  Event bus, BoundIssue
  store/                 Persistence types
  tracker-linear/        Linear integration
  tracker-sentry/        Sentry integration
  scm-github/            GitHub SCM
  im-telegram/           Telegram notifications
  ai-claude-code/        Claude Code AI provider (Sonnet, Opus, Haiku)
  ai-aider/              Aider AI provider (Anthropic, OpenAI, Ollama)
  ai-google/             Google AI provider
```

## How It Works

1. Create a task (CDM) in the dashboard, or import issues from Linear/Sentry
2. An AI agent spawns with its own Git branch and Docker container
3. The agent reads `TASK.md` (what to do) and `CLAUDE.md` (how to do it) and writes code
4. You review changes via built-in code review — leave inline comments
5. Merge into your branch or reject with feedback for a retry

## Integrations

| Integration | Purpose |
|---|---|
| **Linear** | Import issues, sync status and comments |
| **Sentry** | Turn error reports into agent tasks |
| **GitHub** | Push branches, create PRs automatically |
| **Telegram** | Notifications on agent events |

## Configuration

Settings are stored in `.config/` at the workspace root:

- `.config/config.json` — projects, integrations, AI rules, port slots
- `.config/.env.secrets` — API keys and tokens (auto-extracted from config)

> Both files are in `.gitignore`. Never commit them.

## Scripts

```bash
pnpm dev           # Start dev server
pnpm build         # Production build
pnpm start         # Start production server
pnpm test          # Run all tests
```

## Project Structure on Disk

```
<project>/
├── .10timesdev/
│   ├── tasks/              CDM task files
│   ├── agents/
│   │   └── <issueId>/
│   │       └── git/        Isolated repo clone
│   │           └── .10timesdev/
│   │               ├── TASK.md      Task description
│   │               ├── CLAUDE.md    Agent instructions
│   │               ├── RULES.md     AI rules
│   │               └── images/      Task images
│   └── config.json         Project configuration
```

## License

Open source. See [LICENSE](LICENSE) for details.

## Support

If 10TimesDev saves you time, consider supporting the project:

**[☕ Buy me a coffee](https://buymeacoffee.com/radzisz)**
