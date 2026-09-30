# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN npm ci

FROM deps AS build

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/frontend apps/frontend
COPY apps/worker apps/worker

RUN npm run build

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV FRONTEND_DIST=/app/apps/frontend/dist
ENV WORKER_WORK_ROOT=/home/node/.work/jobs
ENV API_UPLOAD_ROOT=/home/node/.work/uploads

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 700 -o node -g node /home/node/.work /home/node/.work/jobs /home/node/.work/uploads

WORKDIR /app

COPY --chown=node:node --from=prod-deps /app/package.json ./package.json
COPY --chown=node:node --from=prod-deps /app/package-lock.json ./package-lock.json
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages ./packages
COPY --chown=node:node --from=build /app/apps ./apps

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
