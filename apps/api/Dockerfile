# The K API container (used by Render's Docker service; Root Directory = apps/api).
# Build stage uses the full Debian image, which already has python3/make/g++ for native modules (argon2).
FROM node:22.11-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22.11-bookworm-slim
WORKDIR /app
RUN useradd --system --uid 10001 app
# Dev dependencies are kept on purpose: the start script runs the TypeScript migration/seed scripts with ts-node.
COPY --from=build --chown=app /app ./
USER app
EXPOSE 10000
# Migrate, seed demo accounts (non-production only), then start. Render injects PORT and all env vars at runtime.
CMD ["sh", "scripts/docker-start.sh"]
