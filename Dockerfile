# Claude Remote Control: gestor + panel web en un solo contenedor.
# Mismo contenedor para Ubuntu (docker compose) y para Umbrel (tienda de apps de LogiQD).

# --- Gestor (TypeScript + node-pty, que se compila en nativo) ---
FROM node:24-trixie-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package*.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# --- Panel (React + Vite) ---
FROM node:24-trixie-slim AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Imagen final ---
FROM node:24-trixie-slim
ARG CLAUDE_VERSION
ARG APP_VERSION=dev
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git tmux tini procps less ripgrep jq openssh-client locales \
 && sed -i 's/^# *es_ES.UTF-8/es_ES.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# Claude Code con versión fija (instalador nativo oficial). Se copia el binario a /usr/local/bin
# para que no dependa del HOME, que en ejecución está en el volumen de datos.
RUN test -n "$CLAUDE_VERSION" \
 && curl -fsSL https://claude.ai/install.sh | HOME=/tmp/claude-install bash -s "$CLAUDE_VERSION" \
 && cp -L /tmp/claude-install/.local/bin/claude /usr/local/bin/claude \
 && rm -rf /tmp/claude-install \
 && claude --version

WORKDIR /app
COPY --from=server /build/server/dist ./server/dist
COPY --from=server /build/server/node_modules ./server/node_modules
COPY --from=server /build/server/package.json ./server/
COPY --from=web /build/web/dist ./web/dist

# Usuario node (UID 1000): el mismo que gery en el host y que umbrel en umbrelOS.
# Todo lo persistente vive en /data: credenciales, conversaciones, ~/.claude y la base de datos.
RUN mkdir -p /data /projects && chown node:node /data /projects
USER node
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    HOME=/data/home \
    CLAUDE_CONFIG_DIR=/data/claude \
    DATA_DIR=/data \
    DISABLE_UPDATES=1 \
    LANG=es_ES.UTF-8 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS -o /dev/null http://127.0.0.1:8080/api/state || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node /app/server/dist/index.js"]
