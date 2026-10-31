FROM node:22.22.3-bookworm-slim AS build
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
ARG APP=gateway
RUN npx nest build ${APP}

FROM node:22.22.3-bookworm-slim AS production-dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild argon2

FROM node:22.22.3-bookworm-slim AS runtime
WORKDIR /usr/src/app

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists /usr/local/lib/node_modules/npm /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd --system app && useradd --system --gid app --create-home app && chown -R app:app /usr/src/app
COPY --from=build --chown=app:app /usr/src/app/package*.json ./
COPY --from=production-dependencies --chown=app:app /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=app:app /usr/src/app/dist ./dist
COPY --from=build --chown=app:app /usr/src/app/apps/auth/migrations ./apps/auth/migrations
COPY --from=build --chown=app:app /usr/src/app/apps/auth/src/database/schema.ts ./apps/auth/src/database/schema.ts
ARG APP=gateway
ENV APP=${APP} NODE_ENV=production NODE_OPTIONS=--max-old-space-size=192
USER app

CMD ["sh", "-c", "node dist/apps/${APP}/main.js"]

FROM runtime AS migration
COPY --chown=app:app scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=app:app apps/catalog/migrations ./apps/catalog/migrations
COPY --chown=app:app apps/booking/migrations ./apps/booking/migrations
COPY --chown=app:app apps/payment/migrations ./apps/payment/migrations
COPY --chown=app:app apps/notification/migrations ./apps/notification/migrations
CMD ["sh", "-c", "node scripts/migrate.mjs ${APP}"]
