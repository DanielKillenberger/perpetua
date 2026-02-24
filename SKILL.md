---
name: perpetua
description: "Transparent OAuth proxy — use a single API key to call any OAuth-protected API. Use when setting up Perpetua (self-hosted or hosted), connecting OAuth providers (Oura, Google Calendar, Strava, Notion, Spotify), proxying API requests, or troubleshooting token issues."
version: 1.0.0
homepage: https://perpetua.sh
metadata: {"openclaw":{"emoji":"🔑","kind":"service","primaryEnv":"PERPETUA_KEY","requires":{"anyBins":["docker","node"]},"install":[{"id":"docker","kind":"brew","formula":"docker","bins":["docker"],"label":"Install Docker (brew)"},{"id":"node","kind":"brew","formula":"node","bins":["node"],"label":"Install Node.js (brew)"}]}}
---

# Perpetua — Never Fix OAuth Tokens Again

OAuth refresh tokens expire. Your OpenClaw skills shouldn't.

Perpetua is a transparent proxy: give it one permanent API key and it handles storage, refresh, and forwarding for Google Calendar, Oura, Strava, Notion, Spotify and more. Your skills just call `/proxy/gcal/...` forever — no more token expiry breaks, no more re-auth.

**Repo:** https://github.com/DanielKillenberger/perpetua

> **Security:** Self-hosted tokens never leave your server (AES-256-GCM encrypted at rest). Hosted (perpetua.sh) stores tokens encrypted with per-user keys — your provider credentials are never shared or exposed.

**Two ways to use Perpetua:**

| | Self-Hosted (OSS) | perpetua.sh (Hosted) |
|---|---|---|
| **Setup time** | 30-60 min (per provider) | 5 min |
| **OAuth app registration** | You register with each provider | Pre-configured |
| **Infrastructure** | You run Docker / Node.js | Managed |
| **Custom providers** | Yes — edit `providers.yml` | No |
| **Cost** | Free | 14-day free trial, then paid |
| **Data control** | Full — your server, your DB | Managed |

## For OpenClaw Users

Once Perpetua is running (self-hosted or via perpetua.sh), any skill can call OAuth APIs with zero token management:

```bash
curl "${PERPETUA_URL}/proxy/gcal/calendars/primary/events?timeMin=..." \
  -H "Authorization: Bearer $PERPETUA_KEY"
```

Your calendar skill, fitness tracker, Strava importer, Notion sync — none of them will ever break because of token expiry again. Connect once, proxy forever.

---

## Option A: perpetua.sh (Hosted)

[perpetua.sh](https://perpetua.sh) is the managed version — no OAuth app registration, no Docker setup. Sign in, connect providers, and get an API key.

**Choose perpetua.sh when:**
- You don't want to register OAuth apps with 5 different providers
- You want zero infrastructure to manage
- You want new providers added automatically

---

## Option B: Self-Hosted (OSS)

**License:** MIT

### Important: You Must Register OAuth Apps Yourself

Self-hosting means **you** must create a developer application with **every OAuth provider** you want to use. Each provider has its own developer portal, approval process, and configuration. Budget 10-30 minutes per provider.

**Pro tip:** Start with just one provider (e.g. Google Calendar) to test your setup, then add the rest.

### 1. Install

```bash
git clone https://github.com/DanielKillenberger/perpetua.git
cd perpetua
cp .env.example .env
```

### 2. Generate Secrets

```bash
# API key — your single key to access Perpetua
openssl rand -hex 32

# Encryption key — encrypts stored OAuth tokens at rest
openssl rand -hex 32
```

Put both values in `.env`.

### 3. Register OAuth Apps & Configure Providers

For each provider, you must:
1. Go to the provider's developer portal
2. Create an OAuth application
3. Set the redirect URI to: `{YOUR_BASE_URL}/auth/{slug}/callback`
4. Copy the Client ID and Client Secret into `.env`

**Callback URL pattern:** `http://localhost:3001/auth/{slug}/callback` (local) or `https://yourdomain.com/auth/{slug}/callback` (production)

#### Google Calendar (`gcal`)

| | |
|---|---|
| **Portal** | https://console.cloud.google.com/apis/credentials |
| **Steps** | Create project → APIs & Services → Credentials → Create OAuth 2.0 Client ID (Web application) |
| **Redirect URI** | `{BASE_URL}/auth/gcal/callback` |
| **Also required** | Enable "Google Calendar API" under APIs & Services → Library |
| **Env vars** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Gotcha** | Google requires a consent screen configuration; for personal use, set to "External" and add yourself as a test user |

#### Oura Ring (`oura`)

| | |
|---|---|
| **Portal** | https://cloud.ouraring.com/oauth/applications |
| **Steps** | Create application → configure redirect URI |
| **Redirect URI** | `{BASE_URL}/auth/oura/callback` |
| **Env vars** | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` |
| **Gotcha** | Requires an Oura account with an active ring subscription |

#### Strava (`strava`)

| | |
|---|---|
| **Portal** | https://www.strava.com/settings/api |
| **Steps** | Create application → set authorization callback domain |
| **Redirect URI** | `{BASE_URL}/auth/strava/callback` |
| **Env vars** | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` |
| **Gotcha** | Strava uses "authorization callback domain" (just the domain, not full URL) for validation |

#### Notion (`notion`)

| | |
|---|---|
| **Portal** | https://www.notion.so/my-integrations |
| **Steps** | Create new integration → set to **Public** (required for OAuth) → configure redirect URI |
| **Redirect URI** | `{BASE_URL}/auth/notion/callback` |
| **Env vars** | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| **Gotcha** | Must be set to "Public" integration type — internal integrations don't support OAuth flow |

#### Spotify (`spotify`)

| | |
|---|---|
| **Portal** | https://developer.spotify.com/dashboard |
| **Steps** | Create app → add redirect URI in settings |
| **Redirect URI** | `{BASE_URL}/auth/spotify/callback` |
| **Env vars** | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| **Gotcha** | New apps are in "development mode" (25 user limit) which is fine for personal use |

#### Adding a Custom Provider

Edit `packages/server/providers.yml`:
```yaml
providers:
  my-provider:
    display_name: "My Provider"
    base_url: "https://api.example.com"
    auth_url: "https://example.com/oauth/authorize"
    token_url: "https://example.com/oauth/token"
    client_id: "${MY_PROVIDER_CLIENT_ID}"
    client_secret: "${MY_PROVIDER_CLIENT_SECRET}"
    scopes:
      - "read"
```

Then add `MY_PROVIDER_CLIENT_ID` and `MY_PROVIDER_CLIENT_SECRET` to `.env`.

### 4. Run

```bash
# Docker (recommended)
docker compose up -d

# Or Node.js directly
npm install && npm run build && cd packages/server && npm install && npm run build && npm start
```

Verify: `curl http://localhost:3001/health`

### 5. Connect a Provider

```bash
# Start OAuth flow (returns a URL to open in browser)
curl -X POST http://localhost:3001/auth/oura/start \
  -H "Authorization: Bearer $PERPETUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account": "personal"}' | jq .auth_url

# Open the URL in your browser → authorize → done
```

### 6. Make Proxied Requests

```bash
# Oura sleep data
curl "http://localhost:3001/proxy/oura/v2/usercollection/daily_sleep" \
  -H "Authorization: Bearer $PERPETUA_KEY"

# Google Calendar events
curl "http://localhost:3001/proxy/gcal/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true&timeMin=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer $PERPETUA_KEY"

# Strava activities
curl "http://localhost:3001/proxy/strava/athlete/activities" \
  -H "Authorization: Bearer $PERPETUA_KEY"

# Notion search
curl "http://localhost:3001/proxy/notion/search" \
  -H "Authorization: Bearer $PERPETUA_KEY" \
  -H "Notion-Version: 2022-06-28"

# Spotify top tracks
curl "http://localhost:3001/proxy/spotify/me/top/tracks" \
  -H "Authorization: Bearer $PERPETUA_KEY"
```

---

## API Reference

### Management

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check |
| `GET /status` | Yes | Connection status + token expiry |
| `GET /providers` | Yes | List configured OAuth providers |
| `GET /connections` | Yes | List stored connections |
| `DELETE /connections/:provider/:account` | Yes | Delete a connection |

### OAuth

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /auth/:provider/start` | No | Start OAuth flow (returns `auth_url`) |
| `GET /auth/:provider/callback` | No | OAuth redirect handler (automatic) |

### Proxy

| Endpoint | Auth | Description |
|----------|------|-------------|
| `ANY /proxy/:provider/*` | Yes | Forward request to provider API |

All authenticated endpoints require: `Authorization: Bearer <your-api-key>`

## Provider Slugs

| Provider | Slug | Proxy base |
|----------|------|------------|
| Google Calendar | `gcal` | `/proxy/gcal/...` |
| Oura Ring | `oura` | `/proxy/oura/...` |
| Strava | `strava` | `/proxy/strava/...` |
| Notion | `notion` | `/proxy/notion/...` |
| Spotify | `spotify` | `/proxy/spotify/...` |

## Troubleshooting

- **"No connection found"** → You haven't authed that provider yet. Run `POST /auth/:provider/start` and open the URL.
- **"Invalid API key"** → Check `Authorization: Bearer` header matches `API_KEY` in `.env`.
- **"Token refresh failed"** → Provider revoked the refresh token. Delete the connection and re-auth.
- **"Database locked"** → Multiple instances writing to same SQLite file. Use a single instance.
