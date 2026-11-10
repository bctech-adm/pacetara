# syntax=docker/dockerfile:1
# Situs statis publik, nginx non-root dari Alpine.
FROM alpine:3.24
RUN apk upgrade --no-cache && apk add --no-cache nginx tini \
  && mkdir -p /tmp/nginx && chown -R nginx:nginx /tmp/nginx /var/lib/nginx /var/log/nginx
COPY nginx.conf /etc/nginx/nginx.conf
COPY site /srv
USER nginx
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["nginx", "-e", "/dev/stderr", "-g", "daemon off;"]
