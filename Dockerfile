# Airplane Ludo - web client (static files served by nginx)
FROM nginx:1.27-alpine

# Render injects PORT (default 10000). Both values below can be overridden at runtime.
ENV PORT=10000 \
    BACKEND_WS_URL=wss://airplaneludo-backend.onrender.com/ludo

# nginx config is rendered from the template at container start (official image feature: envsubst on /etc/nginx/templates)
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Generates /usr/share/nginx/html/config.js from BACKEND_WS_URL at start (no rebuild needed to change backend)
COPY docker/40-generate-config.sh /docker-entrypoint.d/40-generate-config.sh
RUN chmod +x /docker-entrypoint.d/40-generate-config.sh

COPY web/ /usr/share/nginx/html/

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
