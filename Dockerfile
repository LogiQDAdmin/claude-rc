# syntax=docker/dockerfile:1
# Agent RC builds both pinned providers independently from an official Node base.
FROM node:24-trixie-slim AS build-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM build-base AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && node --test test/*.test.mjs && npm prune --omit=dev

FROM build-base AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-trixie-slim AS codex-build
WORKDIR /build/codex
COPY CODEX_VERSION ./
# npm resolves the exact platform package; only the native payload is retained.
RUN set -eu; version="$(cat CODEX_VERSION)"; \
    case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) exit 1 ;; esac; \
    npm install --prefix /tmp/codex-package --omit=dev --no-audit --no-fund "@openai/codex@$version"; \
    case "$(node -p 'process.arch')" in \
      x64) triple=x86_64-unknown-linux-musl; package=codex-linux-x64 ;; \
      arm64) triple=aarch64-unknown-linux-musl; package=codex-linux-arm64 ;; \
      *) echo 'Codex RC supports only amd64 and arm64' >&2; exit 1 ;; \
    esac; \
    payload="/tmp/codex-package/node_modules/@openai/$package/vendor/$triple"; \
    test -x "$payload/bin/codex"; \
    mkdir /native; cp -a "$payload/." /native/; \
    test "$(/native/bin/codex --version)" = "codex-cli $version"; \
    /native/bin/codex --version > /native/version.txt; \
    sha256sum /native/bin/codex | awk '{print $1}' > /native/codex.sha256; \
    chmod -R a-w /native; \
    rm -rf /tmp/codex-package

FROM node:24-trixie-slim AS claude-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bash \
    && rm -rf /var/lib/apt/lists/*
COPY CLAUDE_VERSION /build/CLAUDE_VERSION
RUN set -eu; version="$(cat /build/CLAUDE_VERSION)"; \
    curl -fsSL https://claude.ai/install.sh | HOME=/tmp/claude-install bash -s "$version"; \
    mkdir /native; \
    cp -L /tmp/claude-install/.local/bin/claude /native/claude; \
    test "$(/native/claude --version)" = "$version (Claude Code)"; \
    sha256sum /native/claude | awk '{print $1}' > /native/claude.sha256; \
    chmod -R a-w /native; \
    rm -rf /tmp/claude-install

FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini ca-certificates bash git openssh-client curl ripgrep procps tmux less jq locales \
    && sed -i 's/^# *es_ES.UTF-8/es_ES.UTF-8/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-build /build/server/dist /app/server/dist
COPY --from=server-build /build/server/node_modules /app/server/node_modules
COPY --from=server-build /build/server/package.json /app/server/package.json
COPY --from=web-build /build/web/dist /app/web/dist
COPY --from=codex-build /native /opt/codex
COPY --from=claude-build /native /opt/claude
COPY CODEX_VERSION /app/CODEX_VERSION
COPY CLAUDE_VERSION /app/CLAUDE_VERSION
COPY scripts/ /app/scripts/
RUN set -eu; chmod 0555 /app/scripts/entrypoint.sh /app/scripts/codex-wrapper.mjs /app/scripts/claude-wrapper.mjs; \
    ln -s /opt/codex/bin/codex /opt/codex/codex; \
    ln -s /app/scripts/codex-wrapper.mjs /usr/local/bin/codex; \
    ln -s /app/scripts/claude-wrapper.mjs /usr/local/bin/claude; \
    mkdir -p /data/home /data/claude /data/codex-home /data/codex /data/codex-rc /projects; \
    chown -R node:node /data /projects; \
    test "$(/opt/codex/codex --version)" = "codex-cli $(cat /app/CODEX_VERSION)"; \
    test "$(/opt/claude/claude --version)" = "$(cat /app/CLAUDE_VERSION) (Claude Code)"; \
    test ! -e /usr/local/lib/node_modules/@anthropic-ai
ARG APP_VERSION=0.2.0
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    HOME=/data/home \
    CLAUDE_CONFIG_DIR=/data/claude \
    CLAUDE_BINARY=/opt/claude/claude \
    CLAUDE_TMUX_SOCKET=agent-rc-claude \
    DISABLE_UPDATES=1 \
    DISABLE_AUTOUPDATER=1 \
    CODEX_HOME=/data/codex \
    CODEX_USER_HOME=/data/codex-home \
    CODEX_TMUX_SOCKET=agent-rc-codex \
    DATA_DIR=/data \
    PROJECT_ROOTS=/projects,/data/proyectos \
    PORT=8080 \
    CODEX_BINARY=/opt/codex/codex \
    CODEX_SOCKET_PATH=/data/codex-rc/app-server.sock \
    WEB_DIR=/app/web/dist \
    LANG=es_ES.UTF-8
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=15s --retries=3 \
    CMD ["node", "/app/scripts/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/scripts/entrypoint.sh"]
CMD ["node", "/app/server/dist/index.js"]
