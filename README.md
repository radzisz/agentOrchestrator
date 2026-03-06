# Agent Orchestration System

Orkiestracja agentów AI na produkcyjnym codebase. Linear = jedyne źródło prawdy.

## Pliki

| Skrypt | Opis |
|--------|------|
| `init.sh` | Przygotuj projekt do orkiestracji |
| `dispatcher.sh` | Główna pętla — obserwuje Linear, spawnuje agentów, odpala preview |
| `spawn.sh` | Utwórz agenta dla Linear issue (klon + porty + TASK.md) |
| `preview.sh` | Supabase branch + Netlify preview |
| `merge.sh` | Merge agenta do master (opcjonalnie z feature toggle) |
| `monitor.sh` | Monitor commitów w terminalu (notyfikacje przy 🟡) |
| `status.sh` | Przegląd portów, klonów, Linear issues |
| `ports.sh` | Menedżer portów (source, nie uruchamiaj) |
| `CLAUDE_GLOBAL.md` | Globalne instrukcje dla agentów |

## Quickstart

```bash
# 1. Init projektu
./init.sh ~/<projekt>

# 2. Uzupełnij .env projektu
nano ~/<projekt>/.env
#   LINEAR_API_KEY=lin_api_...
#   LINEAR_TEAM_KEY=uuid-teamu-z-linear

# 3. Uzupełnij CLAUDE.md projektu
nano ~/<projekt>/CLAUDE.md

# 4a. Ręczny spawn
./spawn.sh ~/<projekt> XX-142
cd ~/<projekt>/.10timesdev/agents/XX-142 && claude

# 4b. Albo: automatyczny dispatcher
cd ~/projects    # katalog ZAWIERAJĄCY projekty
~/agentOrchestrator/dispatcher.sh
```

## Autodiscovery

Dispatcher skanuje podkatalogi CWD. Projekt = katalog z `.env` zawierającym:

```bash
# wymagane
LINEAR_API_KEY=lin_api_xxxxx
LINEAR_TEAM_KEY=uuid-teamu-z-linear

# opcjonalne (preview, feature toggles)
SUPABASE_ACCESS_TOKEN=
SUPABASE_PROJECT_REF=
SUPABASE_DB_URL=
NETLIFY_SITE_NAME=
```

Nie trzeba ręcznej konfiguracji — dispatcher sam znajdzie projekty.

## Lifecycle (Linear-driven)

```
Linear issue + label "agent"
  │
  ├─ status: Todo           → dispatcher: spawn.sh
  │                            klon + porty + TASK.md + CLAUDE.md
  │                            status → In Progress
  │
  ├─ komentarz: 🤖 Gotowe   → dispatcher: preview.sh
  │                            Supabase branch + Netlify preview
  │                            komentarz z linkiem na Linear
  │                            status → In Review
  │
  ├─ komentarz: OK (klient)  → dispatcher: notyfikacja do Ciebie
  │
  ├─ TWOJA DECYZJA:
  │   ├─ merge.sh path XX-142                  → merge od razu
  │   ├─ merge.sh path XX-142 --toggle         → merge z toggle OFF
  │   ├─ merge.sh path XX-142 --toggle --enable → merge z toggle ON
  │   └─ merge.sh path XX-142 --reject          → odrzuć
  │                            status → Done / Cancelled
  │
  └─ status: Done/Cancelled  → dispatcher: cleanup
                                usuń klon, zwolnij port, usuń remote branch
```

## Porty

100 slotów (00–99), round-robin, współdzielone między projektami.

```
Slot NN → porty: 4{NN}22  4{NN}23  4{NN}24  (frontend)
                  9{NN}02  9{NN}03  9{NN}04  (backend)
```

Stan: `~/.claude/ports.json`. Podgląd: `./status.sh`

## Struktura

```
~/.claude/
├── CLAUDE_GLOBAL.md          ← zasady globalne
└── ports.json                ← rejestr portów (round-robin)

~/<projekt>/
├── .env                      ← LINEAR_API_KEY + LINEAR_TEAM_KEY
├── CLAUDE.md                 ← specyfika projektu
└── .10timesdev/
    ├── agent-XX-142.json     ← stan agenta
    ├── agents/
    │   ├── XX-142/           ← agent pracujący nad issue XX-142
    │   │   ├── CLAUDE.md     ← porty, tożsamość, zasady
    │   │   ├── TASK.md       ← zadanie z Linear
    │   │   └── (klon repo)
    │   └── ...
    └── logs/
```
