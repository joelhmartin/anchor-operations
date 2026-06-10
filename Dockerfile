# anchor-ops web service image (Cloud Run service).
#
# Serves the React SPA + the /api/auth, /api/ops, /api/operations API and the
# WebSocket terminal. Slimmer than the source monorepo's image: no canvas /
# Chromium / DocAI rasterization (those were CRM/report-PDF concerns that don't
# live in Operations). Native modules that DO matter here — argon2 (password
# hashing) and ssh2 (Kinsta WP-CLI) — are compiled in the build stage.

FROM node:20-bullseye AS build

# Build tools for native modules (argon2, ssh2/cpu-features, protobufjs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    g++ \
    make \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./

RUN corepack enable \
  && yarn install --immutable

COPY . .

RUN yarn build

FROM node:20-bullseye-slim AS production

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/.env.public ./.env.public
COPY --from=build /app/package.json ./package.json

EXPOSE 8080

CMD ["node", "server/index.js"]
