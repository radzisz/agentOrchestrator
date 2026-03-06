# Globalne instrukcje agenta AI

## Tożsamość

Przeczytaj CLAUDE.md w swoim katalogu roboczym — tam są Twoje porty, branch i projekt.
Przeczytaj TASK.md — tam jest Twoje zadanie z Linear.

## Workflow commitów

Każdy commit musi mieć prefix:

- 🟢 AUTO — agent jedzie dalej: refactoring, nowe pliki, styling, oczywiste bugfixy
- 🟡 CHECKPOINT — wymaga review: zmiany API, schema bazy, shared packages, konfiguracja

Format:
```
🟢 [ISSUE_ID] krótki opis
🟡 [ISSUE_ID] krótki opis

CO: co zostało zmienione
DLACZEGO: uzasadnienie
WPŁYW: co może się zepsuć
```

ISSUE_ID = nazwa Twojego katalogu (np. US-142).

## Synchronizacja

- `git fetch origin master && git rebase origin/master` co 3-5 subtasków
- `git push origin HEAD:agent/ISSUE_ID --force-with-lease` po KAŻDYM subtasku
- NIGDY `git push --force` bez `--with-lease`
- NIGDY nie pushuj na origin/master

## Konflikty

- origin/master ma priorytet
- Lockfile: `git checkout origin/master -- pnpm-lock.yaml && pnpm install`
- NIGDY nie modyfikuj kodu z commitów innego agenta

## Baza danych

- TWÓRZ pliki migracji w `supabase/migrations/`
- NIGDY nie wykonuj migracji (`supabase db push`, `supabase migration up`)
- Oznacz commit z migracją jako 🟡

## Zakończenie pracy

Kiedy WSZYSTKIE punkty z TASK.md są zrobione:
1. Wykonaj ostatni push na origin/agent/ISSUE_ID
2. Skomentuj na Linear (curl poniżej):

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { commentCreate(input: { issueId: \"'$LINEAR_ISSUE_ID'\", body: \"🤖 Gotowe\\n\\nPodsumowanie:\\n- [lista co zrobione]\\n\\nBranch: agent/'$ISSUE_ID'\" }) { success } }"}'
```

3. NIE RÓB NIC WIĘCEJ po tym komentarzu.

## Raportowanie postępu

Co 3-5 subtasków skomentuj na Linear:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { commentCreate(input: { issueId: \"'$LINEAR_ISSUE_ID'\", body: \"🤖 Progress\\n\\n- [co zrobione]\\n- [co zostało]\" }) { success } }"}'
```

## Ogólne zasady

- Pracuj TYLKO nad zadaniem z TASK.md
- Pisz testy dla nowego kodu
- Nie instaluj zależności bez uzasadnienia
- Nie zmieniaj CI/CD bez 🟡
- Nie zostawiaj console.log / debugger
- Używaj WYŁĄCZNIE portów z CLAUDE.md w swoim katalogu
