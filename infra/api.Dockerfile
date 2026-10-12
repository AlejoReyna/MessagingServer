FROM node:24-trixie-slim AS base
RUN printf 'deb http://deb.debian.org/debian forky main\n' > /etc/apt/sources.list.d/forky.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -t forky openssl libvips42t64 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -t forky build-essential pkg-config python3 libvips-dev libdeflate-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --global node-gyp@13.1.0
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1 \
    NODE_PATH=/usr/local/lib/node_modules
RUN npm ci
RUN npm explore sharp -- npm run build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY scripts/bootstrap.mjs scripts/bootstrap.mjs
COPY scripts/database-env.mjs scripts/database-env.mjs
RUN npm run build:contracts && npm run build:api

FROM build AS tools
RUN groupadd -g 10001 chat && useradd -u 10001 -g chat -M chat
USER 10001:10001
CMD ["node", "scripts/bootstrap.mjs"]

FROM build AS pruned
RUN npm prune --omit=dev

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -g 10001 chat && useradd -u 10001 -g chat -M chat
COPY --from=pruned /app/node_modules ./node_modules
COPY --from=pruned /app/package.json ./package.json
COPY --from=pruned /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=pruned /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=pruned /app/apps/api ./apps/api
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
