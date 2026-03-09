# Agent Orchestrator

Web-based orchestration of AI coding agents (Claude Code). Supports multiple issue trackers (Linear, Sentry, local), automatic agent spawning, and branch management.

## Architecture

pnpm monorepo:

```
apps/web/              Next.js app (UI + API)
packages/
  contracts/           Abstract base classes (BaseTracker, BaseSCMProvider, BaseAIProvider)
  core/                Event bus, BoundIssue
  store/               Persistence types
  tracker-linear/      Linear integration
  tracker-sentry/      Sentry integration
  scm-github/          GitHub SCM
  im-telegram/         Telegram notifications
  ai-claude-code/      Claude Code AI provider
  ai-aider/            Aider AI provider
  ai-google/           Google AI provider
```

## Development

```bash
pnpm install
pnpm dev          # Next.js dev server
pnpm build        # production build
```

## How it works

1. Issues come from trackers (Linear, Sentry, or local CDM tasks)
2. Dispatcher polls trackers, spawns agents for new issues
3. Each agent gets an isolated git clone + Docker container
4. Agent reads `TASK.md` (issue description) and `CLAUDE.md` (rules + response format)
5. Agent commits changes, coordinator pushes to remote
6. User reviews via UI → merge or reject

## Project structure on disk

```
<project>/
├── .10timesdev/
│   ├── tasks/              CDM task files (tasks.md, images)
│   ├── agents/
│   │   └── <issueId>/
│   │       └── git/        isolated repo clone
│   │           └── .10timesdev/
│   │               ├── TASK.md      task description
│   │               ├── CLAUDE.md    agent instructions
│   │               ├── RULES.md     AI rules (conditional)
│   │               └── images/      downloaded task images
│   └── config.json         project configuration
```
