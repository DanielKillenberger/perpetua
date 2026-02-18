# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps (skip prepare — source not copied yet)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Build shared package
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Install server deps (skip prepare — source not copied yet)
COPY packages/server/package*.json ./packages/server/
RUN cd packages/server && npm ci --ignore-scripts

# Build server
COPY packages/server/tsconfig.json ./packages/server/
COPY packages/server/src/ ./packages/server/src/
RUN cd packages/server && npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Copy root package files and pre-built dist first.
# The server depends on perpetua via file:../../ — npm runs `prepare` on it,
# but our prepare script skips the build when dist/ already exists.
COPY package*.json ./
COPY --from=builder /app/dist ./dist

# Install root production deps (none currently, but keeps package.json valid)
RUN npm ci --omit=dev --ignore-scripts

# Install server production deps (perpetua's prepare will find dist/ and skip)
COPY packages/server/package*.json ./packages/server/
RUN cd packages/server && npm ci --omit=dev

# Copy compiled server output + config
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY packages/server/providers.yml ./packages/server/

# Data dir (mounted as volume)
RUN mkdir -p /app/data

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

# Healthcheck: verify the service is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

CMD ["node", "packages/server/dist/server.js"]
