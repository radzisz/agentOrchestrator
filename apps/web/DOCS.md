# 10times.dev

**Twoi agenci AI pracują równolegle. Ty masz pełną kontrolę.**

---

## Co to jest 10times.dev?

Platforma do orkiestracji agentów AI, która pozwala developerowi pracować 10x szybciej — nie zastępując go, a dając mu zespół autonomicznych agentów, z których każdy realizuje osobne zadanie jednocześnie.

Developer nie traci kontroli. W każdej chwili widzi co robi każdy agent, może podejrzeć live preview działającej aplikacji (lokalnie lub zdalnie), dać feedback, zaakceptować lub odrzucić wynik.

---

## Kluczowe korzyści

### Wielu agentów pracuje jednocześnie
Zamiast sekwencyjnej pracy nad jednym taskiem, możesz uruchomić 5, 10, 20 agentów równolegle — każdy na osobnym zadaniu, osobnym branchu, w izolowanym kontenerze. Twoja przepustowość rośnie liniowo z liczbą agentów.

### Developer ma pełną kontrolę
Agenci nie działają w ciemno. Dashboard pokazuje na żywo: co robi każdy agent, jakie commity powstają, jaki jest status. Telegram powiadamia o każdym zdarzeniu. W dowolnym momencie możesz zatrzymać agenta, dać mu nowe instrukcje albo odrzucić wynik.

### Live preview każdego feature'a
Każdy branch — niezależnie od tego czy pracuje nad nim agent czy developer — można uruchomić jednym kliknięciem:
- **Lokalnie** — serwer deweloperski dostępny pod localhost z kolorowymi wskaźnikami statusu usług
- **Zdalnie** — pełny stack (baza Supabase + deploy Netlify) z linkiem, który możesz wysłać szefowi, klientowi lub testerowi

Nie czekasz na merge żeby zobaczyć efekt. Każdy feature jest dostępny do podglądu w trakcie pracy.

### Pełna izolacja i bezpieczeństwo
Żaden agent nie działa bezpośrednio na Twojej infrastrukturze developerskiej. Każdy agent pracuje wewnątrz izolowanego kontenera Docker — ma własny branch, własny system plików, własny zestaw portów i żadnego dostępu do Twojego środowiska, kluczy SSH, konfiguracji ani innych projektów. Nawet jeśli agent zrobi coś nieprzewidzianego, skutki są zamknięte w kontenerze, który możesz w każdej chwili zatrzymać i usunąć.

Agenci nie widzą się nawzajem. Nie ma konfliktów, wyścigów ani wzajemnego nadpisywania kodu. Merge odbywa się kontrolowanie — po review przez człowieka.

### Od zadania do kodu bez ręcznego zarządzania
Opisz zadanie w Linear, oznacz etykietą. System automatycznie:
1. Pobiera zadanie
2. Spawnuje agenta z pełnym kontekstem (repozytorium, instrukcje, porty)
3. Agent commituje na dedykowany branch
4. Po zakończeniu — powiadomienie i przejście do review
5. Twoja decyzja: merge albo reject

Zero ręcznego tworzenia branchy, przydzielania tasków, pilnowania postępów.

### Feedback loop w naturalnym flow
Agent skończył, ale chcesz poprawki? Napisz komentarz na Linear. System wykryje nową wiadomość, obudzi agenta i przekaże mu Twoje instrukcje. Agent wznawia pracę z pełnym kontekstem poprzedniej sesji. Nie trzeba nic restartować ani kopiować.

### Udostępnianie preview jednym linkiem
Środowisko REMOTE (Supabase + Netlify) generuje publiczny URL preview. Wystarczy go skopiować i wysłać:
- Klientowi — "zobacz jak wygląda nowy feature"
- Szefowi — "to jest fix buga z wczoraj"
- Testerowi — "przetestuj ten flow na branchu"

Każde preview ma automatyczny TTL (24h) z możliwością przedłużenia, więc nie generujesz niepotrzebnych kosztów infrastruktury.

### Automatyczne reagowanie na błędy produkcyjne
Alert Sentry → issue w Linear → agent analizuje stack trace → proponuje fix → PR gotowy do review. Od błędu na produkcji do gotowego poprawki — bez ręcznego przepisywania stacktrace'ów i szukania w kodzie.

### Powiadomienia tam, gdzie pracujesz
Dedykowany wątek Telegram per zadanie. Widzisz na telefonie:
- Kiedy agent zaczął pracę
- Każdy commit z opisem zmian
- Kiedy jest gotowy do review
- Kiedy został zmerge'owany

Nie musisz siedzieć w dashboardzie. Informacje przychodzą do Ciebie.

### Wiele projektów, jeden panel
Obsługujesz kilka produktów? Jeden 10times.dev zarządza agentami dla wszystkich. Każdy projekt ma własną konfigurację (repo, Linear, GitHub, Supabase, Netlify), a wspólny dashboard daje pełen obraz.

---

## Jak to działa

```
    Ty: tworzysz issue w Linear z etykietą "agent"
                        │
                        ▼
    10times.dev: wykrywa zadanie → spawnuje agenta
                        │
                        ▼
    Agent: klonuje repo → czyta zadanie → koduje → commituje
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
          Telegram   Dashboard   Linear
         (notify)   (live view)  (status)
                        │
                        ▼
    Ty: przeglądasz → preview → merge lub feedback
                        │
                ┌───────┴───────┐
                ▼               ▼
            Merge           Feedback
         (→ master)      (→ agent wznawia)
```

---

## Funkcje platformy

### Dashboard
Centrum dowodzenia. Widzisz wszystko w jednym miejscu:
- Ile agentów pracuje teraz
- Na jakim etapie jest każde zadanie
- Activity feed — strumień zdarzeń na żywo (commity, spawny, błędy, merge'e)
- Szybki dostęp do szczegółów każdego agenta

### Zarządzanie projektami
- **Szybkie dodawanie** — podaj URL repozytorium Git lub wskaż lokalny katalog. Nazwa wykrywana automatycznie
- **Trzy zakładki per projekt:**
  - **Local** — konfiguracja runtime Docker, zarządzanie branchami z lokalnym preview, podgląd agentów
  - **Remote** — konfiguracja Supabase/Netlify, zarządzanie branchami z zdalnym preview + TTL
  - **Integrations** — per-projektowe klucze Linear, GitHub, mapowanie Sentry

### Live preview branchów
| Tryb | Co dostarcza | Dla kogo |
|---|---|---|
| **Local** | Docker kontener, localhost, hot-reload, wielousługowość (frontend + backend) | Developer — szybki podgląd |
| **Remote** | Supabase branch DB + Netlify deploy, publiczny URL, pełne migracje | Klient, szef, tester — weryfikacja online |

Oba tryby: start jednym kliknięciem, kolorowe statusy usług, logi, stop.

### Szczegóły agenta
- Logi kontenera na żywo
- Historia zdarzeń (timeline)
- Akcje: obudź z nowymi instrukcjami, zatrzymaj, merguj, odrzuć
- Podgląd diff przed merge'em (lista commitów + statystyki zmian)

### Integracje
| Integracja | Co daje |
|---|---|
| **Telegram** | Powiadomienia w dedykowanym wątku per zadanie — spawn, commity, review, merge |
| **Linear** | Źródło zadań + synchronizacja statusów (Todo → In Progress → In Review → Done) |
| **Sentry** | Alerty produkcyjne automatycznie stają się zadaniami dla agentów |
| **GitHub** | Zarządzanie branchami, tworzenie PR, merge |
| **Local Drive** | Ścieżka bazowa repozytoriów na dysku |

System pluginów — możesz dodać własne integracje (JS/TS).

---

## Cykl życia zadania

| Etap | Co się dzieje | Twoja rola |
|---|---|---|
| **Nowe zadanie** | Issue w Linear z etykietą "agent" | Opisujesz co trzeba zrobić |
| **Agent spawnowany** | Repo sklonowane, kontener uruchomiony, agent czyta TASK.md | Dostajesz powiadomienie |
| **Agent pracuje** | Commituje na branch `agent/{issueId}`, Linear → "In Progress" | Obserwujesz na dashboardzie / Telegramie |
| **Agent gotowy** | Komentarz "Gotowe" na Linear → status "In Review" | Przeglądasz preview (local/remote) |
| **Feedback** | Piszesz komentarz na Linear → agent się budzi i poprawia | Opcjonalnie — iterujesz |
| **Merge** | Klikasz Merge → branch wchodzi do master → Linear → "Done" | Decyzja w Twoich rękach |
| **Cleanup** | Kontener usunięty, branch usunięty, zasoby zwolnione | Automatycznie |

---

## Skalowalność

- Do **100 agentów/preview** równolegle (100 slotów portów × 6 portów każdy)
- Wiele projektów na jednej instancji
- Brak zewnętrznej bazy danych — stan w plikach JSON, zero dodatkowej infrastruktury
- Środowiska REMOTE z automatycznym TTL — nie zapomnisz wyłączyć

---

## Wymagania

| Komponent | Wymagany | Opis |
|---|---|---|
| Docker | Tak | Kontenery agentów i preview |
| Node.js 22+ | Tak | Runtime platformy |
| Klucz API Anthropic | Tak | Napędza Claude Code w kontenerach |
| Linear | Tak | Źródło zadań i synchronizacja statusów |
| GitHub | Opcjonalnie | Branche, PR-y, merge |
| Supabase | Opcjonalnie | Branch bazy danych dla remote preview |
| Netlify | Opcjonalnie | Deploy preview z publicznym URL |
| Telegram | Opcjonalnie | Powiadomienia na telefon |
| Sentry | Opcjonalnie | Auto-taski z alertów produkcyjnych |
