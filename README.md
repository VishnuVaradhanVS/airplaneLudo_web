# Airplane Ludo - Web client

A browser version of your Android game for players without Android devices. It is a static single-page app
(no build step, no framework) served by **nginx in Docker**, and it talks to your existing Kotlin backend using the
**same WebSocket protocol as the Android app** (`/ludo/{roomId}?name=...`, `GamePackets` JSON).

Fonts, sounds, rule videos, colours, board layout and paths are all taken from your Android project
(`web/js/paths.js` is generated directly from `GridPathCords.kt`).

```
airplaneludo-web/
├── Dockerfile                  nginx image; generates config.js from BACKEND_WS_URL at start
├── render.yaml                 Render Blueprint
├── docker-compose.yml          local test: web UI -> your Render backend (or any backend)
├── docker-compose.fullstack.yml  local test: real Kotlin backend + web UI together
├── docker/                     nginx template, security headers, config generator
├── web/                        the app (index.html, css/, js/, assets/)
└── tools/mock-server.js        OPTIONAL: JS port of your backend for quick UI checks without Kotlin/Docker
```

## 1. Test on your machine

Pick whichever fits. All of them end at **http://localhost:8080**. Open it in two different browsers (or one normal +
one private window) to play as two players.

### A) Docker, against your Render backend (closest to production)
```bash
docker compose up --build
```
Uses `wss://airplaneludo-backend.onrender.com/ludo`. The first connection may take up to a minute if the free
Render backend is asleep - the UI shows "Waking up the server" and retries automatically.

### B) Docker, real Kotlin backend on your machine (no Render involved)
```bash
git clone https://github.com/VishnuVaradhanVS/airplaneLudo_backend.git ../airplaneLudo_backend
docker compose -f docker-compose.fullstack.yml up --build
```
Backend: `ws://localhost:10000/ludo/{room}`. (If you run the backend from IntelliJ/Gradle instead, just start it and use
`BACKEND_WS_URL=ws://localhost:10000/ludo docker compose up --build`.)

### C) No Docker, no Kotlin: mock backend (fastest UI check)
Needs Node 18+. `tools/mock-server.js` is a port of your `Main.kt` (same packets, same rules, same strict JSON decoding).
```bash
cd tools && npm install && node mock-server.js --serve-web
```
Web UI on http://localhost:8080, mock backend on ws://localhost:10000. Use it for layout/flow checks only - your real
backend stays the source of truth.

### D) Phone on the same Wi-Fi
Use the machine's LAN IP, e.g. `http://192.168.1.20:8080`. With option B/C the web page automatically points at
`ws://<same-ip>:10000` only for mock mode (C); for A/B set `BACKEND_WS_URL=ws://192.168.1.20:10000/ludo`.
(`?server=ws://host:port/ludo` in the URL also overrides the backend, but only on localhost/private-network hosts.)

## 2. Deploy on Render

1. Put this folder in a GitHub repo (it must contain the `Dockerfile` at the root).
2. Render dashboard -> **New + -> Blueprint** -> select the repo (it reads `render.yaml`).
   *Or* New + -> Web Service -> your repo -> Runtime **Docker**, health check path `/healthz`.
3. Environment variable `BACKEND_WS_URL` = `wss://<your-backend>.onrender.com/ludo` (already the default).
4. Deploy. Render sets `PORT` automatically; nginx listens on it.

Changing the backend later = edit the env var and redeploy/restart (no image rebuild; `config.js` is generated at start).
`https://...` URLs and a missing `/ludo` suffix are accepted and normalised.

## 3. How it maps to your backend

| Android app | Web client |
|---|---|
| `ws://.../ludo/{roomId}?name=` | same (`wss://` on the web, required because the page is https) |
| CREATE = random 1000-9999 room | same |
| Lobby: SwapTeam / Kick / ChangeTokenCount(4,6,8,12) / StartGame | same packets; host taps a player to get SWAP/KICK (instead of long-press) |
| RollDice, SpawnToken(1 or 5), AnimateTokenMovement + MoveToken | same, incl. step-by-step 400 ms animation and capture walk-back |
| Dice pool, safe cells, home-path unlock after capture, loop path | rendered from server state exactly like the app |
| Sounds, background music, rules videos | included (music/sfx start after first tap - browser autoplay rule) |

Web extras: copy room code / invite link (`?room=1234` pre-fills the join dialog), auto-retry while a sleeping
Render backend wakes up (plus a background "wake-up ping" when the page loads), responsive layout (phone portrait,
desktop side-by-side).

## 4. Things worth knowing

* **No CORS setup needed.** Browsers do not apply CORS to WebSockets and your Ktor server does not check `Origin`.
* **Local (same-Wi-Fi) multiplayer is Android-only** - it relies on the phone hosting the server and NSD discovery.
* **Joining a room code that does not exist creates it** and makes you host. That is how the backend works today (same in the app).
* **No reconnect.** The backend gives every connection a new player id, so a dropped connection means rejoining. (Same as the app.)
* The server decodes packets strictly; the client only sends fields the Kotlin `GamePackets` class knows. If you add fields
  to `GamePackets`, update `web/js/app.js` (`send(...)` calls).
* The server is multi-room and in-memory: a Render restart ends all running games.

## 5. Troubleshooting

* *"Could not reach the game server"* - backend asleep/down, or wrong `BACKEND_WS_URL`. Open the backend URL in a browser once, wait, retry.
* *Mixed-content/blocked* - an https page cannot open `ws://`; use `wss://` for deployed backends (`ws://` is fine on localhost).
* *No sound* - click anywhere first; check the MUSIC toggle on the dashboard.
* Add `?debug` to the URL to expose `window.__ludo.S` (game state) in the browser console.
