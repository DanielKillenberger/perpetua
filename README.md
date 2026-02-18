# Perpetua

[![Tests](https://github.com/DanielKillenberger/perpetua/actions/workflows/test.yml/badge.svg)](https://github.com/DanielKillenberger/perpetua/actions)
[![codecov](https://codecov.io/gh/DanielKillenberger/perpetua/graph/badge.svg)](https://codecov.io/gh/DanielKillenberger/perpetua)

**Perpetua** is a transparent OAuth proxy that lets you access authenticated APIs with a single, long-lived API key instead of managing OAuth tokens manually.

```
┌─────────────┐
│   Client    │
│  (app, CLI) │
└──────┬──────┘
       │ Authorization: Bearer <perpetua-api-key>
       ↓
┌──────────────────────────────────────┐
│         Perpetua (this service)      │
│  ✓ Auto-refreshes OAuth tokens       │
│  ✓ Stores tokens securely (encrypted)│
│  ✓ Transparent request forwarding    │
└──────────────────┬───────────────────┘
                   │ Authorization: Bearer <provider-access-token>
                   ↓
        ┌──────────────────────┐
        │  Provider API        │
        │  (Oura, Google, etc) │
        └──────────────────────┘
```

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/DanielKillenberger/perpetua.git
cd perpetua
npm install
```

### 2. Configure

```bash
# Copy the example config
cp .env.example .env

# Edit .env with your OAuth credentials:
# - API_KEY: Your secret key to access Perpetua (generate: openssl rand -hex 32)
# - ENCRYPTION_KEY: Key to encrypt tokens at rest (generate: openssl rand -hex 32)
# - OURA_CLIENT_ID, OURA_CLIENT_SECRET: From Oura dev portal
# - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: From GCP console
```

### 3. Run with Docker Compose

```bash
docker-compose up -d
```

Verify it's running:
```bash
curl http://localhost:3001/health
```

### 4. Connect an OAuth provider

```bash
# Get the authorization URL
curl -X POST http://localhost:3001/auth/oura/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-api-key>" \
  -d '{"account": "daniel"}' | jq .auth_url

# Open the returned URL in your browser and authorize
# You'll be redirected back to Perpetua
```

### 5. Make proxied requests

```bash
# Now you can call any Oura endpoint with your Perpetua API key
curl "http://localhost:3001/proxy/oura/v2/usercollection/daily_sleep" \
  -H "Authorization: Bearer <your-api-key>" | jq .
```

---

## perpetua.sh — Managed Version

Don't want to self-host? [perpetua.sh](https://perpetua.sh) is the managed version — skip the OAuth app registration, Docker setup, and infrastructure management.

| | Self-Hosted (this repo) | [perpetua.sh](https://perpetua.sh) |
|---|---|---|
| **Setup time** | 30-60 min (per provider) | 5 min |
| **OAuth app registration** | You register with each provider | Pre-configured |
| **Infrastructure** | You run Docker / Node.js | Managed |
| **Custom providers** | Yes — edit `providers.yml` | No |
| **Cost** | Free | 14-day free trial, then paid |
| **Data control** | Full — your server, your DB | Managed |

---

## How It Works

**The Problem:** OAuth tokens expire. You have to refresh them manually, store them securely, and retry requests when they're stale. Building this into every script and tool is tedious and error-prone.

**The Solution:** Perpetua acts as a stateful OAuth proxy. You authenticate with Perpetua once per provider, and Perpetua gives you a long-lived API key. From then on:

1. You send requests to Perpetua with your API key
2. Perpetua checks if the stored OAuth token is expired
3. If expired, Perpetua refreshes it automatically using the stored refresh token
4. Perpetua forwards your request to the real API with the fresh token
5. You get the response back

**Security:** Refresh tokens are encrypted at rest with AES-256-GCM. Your Perpetua API key is all you need to access your data.

---

## API Reference

### Health & Status

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check (for load balancers) |
| `GET /status` | **Yes** | Connection status & token expiry info |
| `GET /providers` | **Yes** | List registered OAuth providers |
| `GET /connections` | **Yes** | List stored connections |

### OAuth Management

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /auth/:provider/start` | No | Initiate OAuth flow (returns auth_url) |
| `GET /auth/:provider/callback` | No | OAuth redirect target (automatic) |
| `DELETE /connections/:provider/:account` | **Yes** | Revoke and delete a connection |

### Proxy

| Endpoint | Auth | Description |
|----------|------|-------------|
| `ANY /proxy/:provider/*` | **Yes** | Forward any HTTP request to provider |

---

## Usage Examples

### Get next 10 calendar events (Google Calendar)

```bash
curl "http://localhost:3001/proxy/gcal/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true&timeMin=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $API_KEY" | jq '.items[] | {summary, start}'
```

### List activities (Strava)

```bash
curl "http://localhost:3001/proxy/strava/athlete/activities" \
  -H "Authorization: Bearer $API_KEY" | jq '.[].name'
```

### Get your Notion databases

```bash
curl "http://localhost:3001/proxy/notion/search?filter={\"property\":\"object\",\"value\":\"database\"}" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Notion-Version: 2022-06-28" | jq '.results[] | {id, title: .title[0].plain_text}'
```

### Delete a connection

```bash
curl -X DELETE "http://localhost:3001/connections/oura/daniel" \
  -H "Authorization: Bearer $API_KEY"
```

---

## Supported Providers

| Provider | Slug | Status | Setup |
|----------|------|--------|-------|
| Oura Ring | `oura` | ✅ | [Docs](https://cloud.ouraring.com/oauth/applications) |
| Google Calendar | `gcal` | ✅ | [Docs](https://console.cloud.google.com/apis) |
| Strava | `strava` | ✅ | [Docs](https://developers.strava.com/docs/getting-started) |
| Notion | `notion` | ✅ | [Docs](https://developers.notion.com/docs/getting-started) |
| Spotify | `spotify` | ✅ | [Docs](https://developer.spotify.com/docs/web-api) |

**Adding a new provider:** Edit `packages/server/providers.yml` with the OAuth endpoints and scopes, then add environment variables for `{PROVIDER}_CLIENT_ID` and `{PROVIDER}_CLIENT_SECRET`.

---

## Security

- **Encryption:** Refresh tokens are encrypted at rest using AES-256-GCM
- **API Key Authentication:** All endpoints (except `/health` and OAuth callbacks) require a valid API key in the `Authorization: Bearer <key>` header
- **No Secrets in Logs:** API keys and tokens are never logged
- **Timing-Safe Comparison:** API key validation uses constant-time comparison to prevent timing attacks
- **HTTPS Recommended:** For production, run behind HTTPS (Perpetua doesn't handle TLS itself)

---

## Installation & Deployment

### Docker (Recommended)

```bash
# Build and run with docker-compose
docker-compose up -d

# Verify
curl http://localhost:3001/health

# View logs
docker-compose logs -f perpetua
```

Environment variables are loaded from `.env`. The SQLite database persists in a Docker volume.

### npm (Development)

```bash
# Install dependencies and build
npm install && npm run build

# Install server dependencies
cd packages/server && npm install

# Run server (dev mode with auto-reload)
cd packages/server && npm run dev

# Or build and run (production)
cd packages/server && npm run build && npm start
```

---

## Configuration

Create a `.env` file (or set environment variables):

```bash
# API key for accessing Perpetua (generate with: openssl rand -hex 32)
API_KEY=your-secret-key

# Encryption key for storing tokens (64-char hex = 32 bytes)
# Generate with: openssl rand -hex 32
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000

# Server
PORT=3001
HOST=0.0.0.0
LOG_LEVEL=info
BASE_URL=http://localhost:3001  # For local; use https://your-domain.com for prod

# Database path (optional)
DB_PATH=./data/perpetua.db

# Providers config file (optional, defaults to packages/server/providers.yml)
# PROVIDERS_FILE=./packages/server/providers.yml

# OAuth credentials (required for each provider you want to use)
OURA_CLIENT_ID=...
OURA_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

---

## Troubleshooting

### "No connection found for provider"

**Cause:** You haven't authenticated with that provider yet.

**Fix:** Run the OAuth flow:
```bash
curl -X POST http://localhost:3001/auth/oura/start \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"account": "personal"}' | jq .auth_url
# Open the URL in your browser
```

### "Invalid API key"

**Cause:** The `Authorization: Bearer <key>` header is wrong or missing.

**Fix:** Verify your API key matches `API_KEY` in `.env`.

### "Token refresh failed"

**Cause:** The OAuth provider rejected the refresh token (it may have been revoked).

**Fix:** Re-authenticate:
```bash
curl -X DELETE http://localhost:3001/connections/oura/daniel \
  -H "Authorization: Bearer $API_KEY"

# Then run the auth flow again
```

### Database locked

**Cause:** Multiple instances writing to the same SQLite file.

**Fix:** Use a single instance or switch to PostgreSQL (contribution welcome).

---

## Testing

```bash
# Run crypto / shared tests
npm test

# Run server tests
cd packages/server && npm test

# Run all tests
npm run test:all

# Server coverage report
cd packages/server && npm run test:coverage
```

---

## Architecture

This is a monorepo with two packages:

- **`perpetua`** (root) — Shared crypto helpers (AES-256-GCM) and token store interfaces. Zero runtime dependencies. Also used by the managed platform [perpetua.sh](https://perpetua.sh).
- **`perpetua-server`** (`packages/server/`) — Self-hosted OAuth proxy server with Fastify, SQLite, and background token refresh.

```
perpetua/                              Root package (name: "perpetua")
├── src/
│   ├── crypto.ts                      AES-256-GCM encrypt/decrypt utilities
│   └── store/
│       └── ITokenStore.ts             Interface for pluggable storage backends
├── __tests__/
│   └── crypto.test.ts                 Crypto tests
├── packages/
│   └── server/                        Server package (name: "perpetua-server")
│       ├── providers.yml              OAuth provider configuration
│       └── src/
│           ├── server.ts              Fastify app & route wiring
│           ├── proxy.ts               Core proxy handler (request forwarding + token refresh)
│           ├── auth.ts                OAuth flow routes
│           ├── middleware.ts          API key authentication middleware
│           ├── providers.ts           Provider registry (loads providers.yml)
│           ├── refresh.ts             Background token refresh loop
│           ├── store/
│           │   ├── SQLiteStore.ts     SQLite implementation with encrypted refresh tokens
│           │   └── index.ts           Barrel export
│           └── __tests__/             Server tests
├── Dockerfile                         Multi-stage build for production
└── docker-compose.yml                 Development & production deployment
```

---

## Contributing

1. **Add a new provider:** Edit `packages/server/providers.yml`, add OAuth endpoints and scopes
2. **Report issues:** Open an issue on GitHub with error logs
3. **Improve Perpetua:** PRs welcome for bugfixes and features

---

## License

[MIT](LICENSE)

---

## What's Next?

- Use your Perpetua instance in shell scripts: `export API_KEY=...; curl http://localhost:3001/proxy/...`
- Integrate with home automation (Home Assistant, n8n, etc.)
- Build dashboards that pull from multiple OAuth APIs without managing tokens
- Use Perpetua as a sidecar in Kubernetes for pod-to-pod OAuth proxying
