# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# File statis disajikan nginx dari Alpine (tanpa biner Go, non-root).
FROM alpine:3.24
RUN apk upgrade --no-cache && apk add --no-cache nginx tini \
  && mkdir -p /tmp/nginx && chown -R nginx:nginx /tmp/nginx /var/lib/nginx /var/log/nginx
COPY nginx.conf /etc/nginx/nginx.conf
COPY --chmod=755 entrypoint.sh /entrypoint.sh
COPY --from=build /app/dist /srv
USER nginx
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
