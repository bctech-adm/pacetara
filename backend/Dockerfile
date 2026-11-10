# syntax=docker/dockerfile:1
# Satu image untuk API, worker, dan migrate (beda perintah di docker-compose.yml).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Patch Alpine terbaru; npm/npx/corepack tidak dipakai saat runtime dan dibuang (permukaan serangan + temuan Trivy).
RUN apk upgrade --no-cache && apk add --no-cache tini \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/main.js"]
