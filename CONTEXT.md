# CONTEXT.md — Stan prac nad agentOrchestrator

Ten plik jest streszczeniem konwersacji z Claude (2 marca 2026) obejmującej architekturę systemu orkiestracji agentów AI, materiały konferencyjne i implementację skryptów. Użyj go jako kontekst przy dalszej pracy w Claude Code.

---

## Co to jest

System orkiestracji agentów AI (Claude Code) na produkcyjnych codebase'ach. Jeden developer, wielu agentów, Linear jako jedyne źródło prawdy. Agenci spawnują się per ficzer/issue, pracują na izolowanych klonach repo z własnymi portami i bazami danych, a ich lifecycle jest w pełni sterowany statusami i komentarzami w Linear.

Twórca: Dominik — solo developer, founder UkryteSkarby.pl, były wykładowca akademicki.

---

## Architektura (finalna)

### Struktura katalogów

```
~/agentOrchestrator/                ← OSOBNE REPO z narzędziami
├── dispatcher.sh                   ← główna pętla (poll Linear co 60s)
├── spawn.sh                        ← utwórz agenta per Linear issue
├── preview.sh                      ← Supabase branch + Netlify preview
├── merge.sh                        ← merge do master + feature toggle
├── monitor.sh                      ← monitor commitów (notyfikacje 🟡)
├── status.sh                       ← przegląd portów, klonów, Linear
├── init.sh                         ← przygotuj projekt do orkiestracji
├── ports.sh                        ← globalny menedżer portów (source)
├── CLAUDE_GLOBAL.md                ← instrukcje globalne dla agentów
└── README.md

~/.claude/                          ← STAN GLOBALNY (nie w repo)
├── CLAUDE_GLOBAL.md                ← kopia (init.sh kopiuje)
└── ports.json                      ← rejestr portów round-robin

~/<projekt-1>/                      ← PROJEKT 1
├── .env                            ← LINEAR_API_KEY + LINEAR_TEAM_KEY
├── CLAUDE.md                       ← specyfika projektu
└── .10timesdev/
    ├── agent-XX-142.json           ← stan agenta
    ├── agents/
    │   ├── XX-142/                 ← agent = issue z Linear
    │   │   ├── CLAUDE.md           ← porty, tożsamość, zasady
    │   │   ├── TASK.md             ← zadanie pobrane z Linear API
    │   │   └── (pełny klon repo)
    │   └── XX-187/
    └── logs/

~/<projekt-2>/                      ← PROJEKT 2 (ta sama struktura)
├── .env
├── CLAUDE.md
└── .10timesdev/
    └── agents/
        └── YY-31/
```

### Kluczowe decyzje architektoniczne

1. **Agent per ficzer, nie per numer** — katalog = ID issue z Linear (US-142, PAR-31). Agent żyje tak długo jak ficzer. Brak stałych agent-01, agent-02.

2. **Linear = jedyne źródło prawdy** — żadnych plików DONE, lockfile'ów. Stan agenta = status + komentarze na Linear issue. Dispatcher reaguje na zmiany statusu.

3. **Porty globalne, round-robin** — 100 slotów (00-99), współdzielone między WSZYSTKIMI projektami. Slot NN → porty `4{NN}22`, `4{NN}23`, `4{NN}24` (frontend), `9{NN}02`, `9{NN}03`, `9{NN}04` (backend). Stan w `~/.claude/ports.json`.

4. **Pełne klony repo** (nie git worktree) — każdy agent ma izolowany katalog z własnym node_modules, .env, itd.

5. **Supabase Branching** (Pro plan) — per ficzer izolowana baza danych, auth, storage, edge functions. Tworzone automatycznie przez Management API.

6. **Trzy warstwy instrukcji**: CLAUDE_GLOBAL.md (workflow) → CLAUDE.md projektu (stack) → CLAUDE.md agenta (porty, tożsamość).

7. **Narzędzie w osobnym repo** (`~/agentOrchestrator/`) — wersjonowane niezależnie od projektów, współdzielone z klientami.

### Linear-driven lifecycle

```
Label "agent" + status: Todo
  → dispatcher: spawn.sh (klon + porty + TASK.md + CLAUDE.md)
  → status → In Progress

Komentarz agenta: "🤖 Gotowe"
  → dispatcher: preview.sh (Supabase branch + Netlify)
  → komentarz z linkiem preview na Linear
  → status → In Review

Komentarz klienta: "OK"
  → dispatcher: notyfikacja do Ciebie

TWOJA DECYZJA:
  merge.sh path US-142                    → merge od razu
  merge.sh path US-142 --toggle           → merge z toggle OFF
  merge.sh path US-142 --toggle --enable  → merge z toggle ON
  merge.sh path US-142 --reject           → odrzuć
  → status → Done / Cancelled

Status: Done/Cancelled
  → dispatcher: cleanup (usuń klon, zwolnij port, usuń remote branch)
```

### Klasyfikacja commitów

- 🟢 AUTO — agent jedzie dalej (refactoring, nowe pliki, styling)
- 🟡 CHECKPOINT — wymaga review (zmiany API, schema, shared packages)

Agent nigdy nie czeka na review. Push na `origin/agent/ISSUE_ID` po każdym subtasku. Rebase na `origin/master` co 3-5 subtasków.

### Feature toggles

Tabela `feature_toggles` w Supabase:
- `enabled=false`, `enabled_for=[]` → OFF
- `enabled=false`, `enabled_for=['user-1']` → per user
- `enabled=true` → ON dla wszystkich

Cache 30s. Jedna zmiana w bazie = natychmiastowy efekt po expiry cache.

### Autodiscovery projektów

Dispatcher skanuje podkatalogi CWD. Projekt = katalog z `.env` zawierającym:

```bash
# .env projektu (wymagane)
LINEAR_API_KEY=lin_api_xxxxx        # Linear API key
LINEAR_TEAM_KEY=uuid-teamu-linear    # UUID teamu w Linear

# Opcjonalne (preview, feature toggles)
SUPABASE_ACCESS_TOKEN=              # Supabase Personal Access Token
SUPABASE_PROJECT_REF=               # Supabase project ref
SUPABASE_DB_URL=                    # Connection string (feature toggles)
NETLIFY_SITE_NAME=                  # Netlify site name (preview URL)
```

Nie trzeba ręcznie konfigurować `LINEAR_PROJECTS`. Wystarczy:
```bash
cd ~/projects    # katalog z projektami
~/agentOrchestrator/dispatcher.sh
```
Dispatcher sam znajdzie wszystkie projekty z `.env`.

---

## Materiały konferencyjne

### Tytuł
**„Jesteś ważniejszy niż wielu agentów"**

Subtitle: *O orkiestracji, wąskich gardłach i tym, czego AI nie zrobi za Ciebie — Praktyczny przewodnik po zarządzaniu zespołem, który nie istnieje.*

Referencja biblijna (nieujawniona na scenie): Mt 10:31 — „Jesteście ważniejsi niż wiele wróbli"

### Teza
Trzecia perspektywa (nie „AI zastąpi" ani „AI to narzędzie"): im więcej agentów, tym WAŻNIEJSZY stajesz się Ty jako orkiestrator. Agent nie potrafi odróżnić sztuki od badziewia. Twój osąd, wyczucie, doświadczenie zarządzania zespołem — to decyduje o sukcesie.

### Opener (do szlifowania językowo — surowy materiał)

Historia z czasów wykładowcy: zespół developerów, poranne spotkania, walidacja 48h później. Dziś to samo — ale 10 minut, nie 48h. I to nie ludzie, to agenci.

Kluczowy fragment: inżynieria oprogramowania to metodologia pracy z LUDŹMI, która kopiuje się 1:1 na agentów. Agenci potrzebują tego samego co juniorzy — częstych, małych korekt. Agent nie rozumie sztuki tworzenia oprogramowania — ludzkiego dotyku, wyczucia, rozumienia — które jest kluczowe dla sukcesu aplikacji, produktu i firmy.

### Formaty
- 50 minut: pełne 6 bloków + live demo + Q&A
- 25 minut: skondensowane, jedna demo, mocniejsza pointa
- Workshop: 4-8h, uczestnicy budują na swoim repo

### Pliki konferencyjne (w /mnt/user-data/outputs/)
- `conference-proposal.docx` — gotowa propozycja do organizatorów (z elevator pitch, detailed description, content, takeaways, target audience, notes z alternatywnymi ścieżkami i wersją 25min)
- `conference-proposal.md` — to samo w markdown
- `conference-materials.md` — wewnętrzny dokument: elevator pitche, zajawka artykułu, opener, strategia sprzedażowa

### Strategia sprzedażowa

Talk = demo kompetencji. Ostatni slajd z QR kodem zostaje przez Q&A.

**Lejek:** scena → QR → landing page → ścieżka 1 (email za skrypty → 3 maile) / ścieżka 2 (Calendly → discovery call)

**Trzy produkty:**
- Audyt (2-3 dni) — analiza codebase + rekomendacja
- Szkolenie (4h/1 dzień/3 dni) — uczestnicy wychodzą z działającym setupem
- Mentoring (miesięczny) — 1:1 lub team, Slack + sesje

**Target konferencje:** BoilingFrogs, WarsawJS/KrakowJS, 4Developers, Infoshare, Confitura, DevConf, Segfault, Grill IT. International: JSConf, AI Engineer Summit, LeadDev.

---

## Co jest ZROBIONE

- [x] Architektura systemu (finalna — agent per ficzer, Linear-driven)
- [x] 9 skryptów bash implementujących cały lifecycle
- [x] Globalny menedżer portów (100 slotów, round-robin, cross-project)
- [x] CLAUDE_GLOBAL.md — instrukcje dla agentów
- [x] Propozycja konferencyjna (docx + md) ze wszystkimi sekcjami
- [x] Materiały wewnętrzne (elevator pitche, opener, strategia sprzedażowa)
- [x] Feature toggle system (schema + helper TypeScript)

## Co jest DO ZROBIENIA

- [ ] Przetestować skrypty na żywym Linear + repo
- [ ] Uzupełnić CLAUDE.md projektu UkryteSkarby (specyfika stacku)
- [ ] Uzupełnić CLAUDE.md projektu parafia-piaskiwielkie
- [ ] Git init `~/agentOrchestrator/`, push na GitHub
- [ ] Landing page (dominik.dev/agenci) — struktura w conference-materials.md
- [ ] Sekwencja 3 maili po pobraniu skryptów
- [ ] Wersja angielska materiałów konferencyjnych (dla JSConf, LeadDev)
- [ ] Feature toggle helper: skopiować `feature-toggles.ts` do `packages/shared/`
- [ ] Migracja SQL: tabela `feature_toggles`
- [ ] Nagranie demo (backup dla live demo na konferencji)
- [ ] Szlifowanie językowe openera (przeczytać na głos kilka razy)
- [ ] Ceny w ofercie konsultingowej (X zł → realne kwoty)

---

## Jak kontynuować w Claude Code

```bash
# Setup nowego projektu:
~/agentOrchestrator/init.sh ~/mojprojekt   # tworzy .env, CLAUDE.md, .10timesdev/
# Uzupełnij .env (LINEAR_API_KEY + LINEAR_TEAM_KEY)

# Uruchom dispatcher:
cd ~/projects                              # katalog z projektami
~/agentOrchestrator/dispatcher.sh          # autodiscovery z .env
```

Kluczowe pliki do dalszej pracy:
- Skrypty: `~/agentOrchestrator/*.sh`
- Kontekst: ten plik (`CONTEXT.md`)
- Konferencja: `conference-materials.md`, `conference-proposal.md`