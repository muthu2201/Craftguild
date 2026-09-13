# syntax=docker/dockerfile:1.7

# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npx tsc -p tsconfig.json

# Reinstall without dev dependencies for the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

# Run unprivileged. The image carries no shell tooling it does not need.
RUN groupadd --system --gid 10001 craftguild \
 && useradd --system --uid 10001 --gid craftguild --home /app craftguild

COPY --from=build --chown=craftguild:craftguild /app/node_modules ./node_modules
COPY --from=build --chown=craftguild:craftguild /app/dist ./dist
COPY --from=build --chown=craftguild:craftguild /app/migrations ./migrations
COPY --chown=craftguild:craftguild package.json ./

USER craftguild
EXPOSE 8080

# The API and the worker are the same image with a different entrypoint, so a
# deploy can never ship a worker built from a different commit than the API.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/http/server.js"]
