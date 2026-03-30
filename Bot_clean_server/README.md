# Pump Profi Bot – Sniper + Trend Mode

Start:

```bash
npm install
npm run dev:bot
npm run dev:dashboard
```

Dashboard: http://localhost:3000

Hinweis: Trage vor Live-Trading eigene Keys in `.env` ein.


## Neu: bessere Entry-Qualität

Der Bot beobachtet Kandidaten jetzt über mehrere Zyklen und kauft nicht mehr sofort beim ersten Signal. Standardmäßig gilt:

- erst Bestätigung über mehrere Schleifen
- kleiner Pullback statt blindem Chasing
- Früh-Einstieg nur bei Elite-Signal
- WATCH-Entscheidungen werden geloggt, bis der Entry sauber ist

## Watchlist Engine
- persistente Watchlist in SQLite (`runtime_watchlist`)
- Kauf nur noch aus READY-Watchlist
- Dashboard zeigt aktive Watchlist aus DB
- schwache / veraltete Coins werden automatisch entfernt

Empfohlene Settings:

```env
WATCHLIST_MAX_SIZE=60
WATCHLIST_MIN_SCORE=55
WATCHLIST_TTL_SECONDS=900
WATCHLIST_READY_MIN_SCORE=62
WATCHLIST_REJECT_DROP_SCORE=42
ENTRY_CONFIRM_CYCLES=3
ENTRY_CONFIRM_SECONDS=8
ENTRY_AI_MIN_SCORE=64
TP_PCT=0.30
SL_PCT=0.035
TRAILING_STOP_PCT=0.045
```

## Neu eingebaut
- User-Profile CRUD im Dashboard/Backend
- automatische Solana-Wallet-Erstellung pro Nutzer
- Wallet-Neugenerierung per Klick
- einfache AI-Profilanalyse pro Nutzer
- neue `/users` Übersicht sowie User-Panel im Hauptdashboard

## Neue API-Endpunkte
- `GET /api/users`
- `POST /api/users`
- `GET /api/users/:id`
- `PUT /api/users/:id`
- `POST /api/users/:id/wallet`
- `GET /api/users/:id/ai`
- `DELETE /api/users/:id`
