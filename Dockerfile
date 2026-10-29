FROM node:22.22.3-bookworm-slim AS build
WORKDIR /usr/src/app
ARG APP=gateway

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx nest build ${APP}

FROM node:22.22.3-bookworm-slim AS production-dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2

FROM node:22.22.3-bookworm-slim AS runtime
WORKDIR /usr/src/app
ARG APP=gateway
ENV APP=${APP} NODE_ENV=production NODE_OPTIONS=--max-old-space-size=192

RUN groupadd --system app && useradd --system --gid app --create-home app && chown -R app:app /usr/src/app
COPY --from=build --chown=app:app /usr/src/app/package*.json ./
COPY --from=production-dependencies --chown=app:app /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=app:app /usr/src/app/dist ./dist
COPY --from=build --chown=app:app /usr/src/app/apps/auth/migrations ./apps/auth/migrations
COPY --from=build --chown=app:app /usr/src/app/apps/auth/src/database/schema.ts ./apps/auth/src/database/schema.ts
USER app

CMD ["sh", "-c", "node dist/apps/${APP}/main.js"]

FROM build AS migration
USER node
