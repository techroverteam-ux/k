FROM node:22.11-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.11-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 app
COPY --from=build --chown=app /app/node_modules ./node_modules
COPY --from=build --chown=app /app/dist ./dist
COPY --from=build --chown=app /app/drizzle ./drizzle
COPY --chown=app package.json ./
USER app
EXPOSE 4000
CMD ["node", "dist/main.js"]
