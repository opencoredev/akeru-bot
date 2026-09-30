FROM node:24.13.1-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @t3tools/web build
RUN node apps/server/scripts/cli.ts build
RUN pnpm --config.inject-workspace-packages=true --filter akeru-bot deploy --prod /runtime \
  && rm -f /runtime/node_modules/.pnpm/node_modules/akeru-bot \
  && mkdir -p /runtime/node_modules/akeru-bot \
  && mv /runtime/dist /runtime/node_modules/akeru-bot/dist

FROM node:24.13.1-bookworm-slim
ENV NODE_ENV=production T3CODE_MODE=web T3CODE_HOST=0.0.0.0 T3CODE_PORT=3773 T3CODE_NO_BROWSER=true AKERU_HOME=/data AKERU_INSTALL_ROOT=/opt/akeru AKERU_BIN_DIR=/usr/local/bin AKERU_REMOTE_CONTAINER=1 AKERU_SERVER_ENTRYPOINT=/opt/akeru/node_modules/akeru-bot/dist/bin.mjs AKERU_SERVER_COMMAND=/usr/local/bin/akeru
WORKDIR /opt/akeru
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /runtime ./
COPY --from=build /src/LICENSE ./LICENSE
COPY --from=build /src/apps/server/package.json ./package.json
COPY scripts/akeru-remote-admin.sh ./remote-admin
COPY scripts/initialize-remote-identity.sh ./initialize-remote-identity.sh
COPY deploy/docker/akeru-entrypoint.sh /usr/local/bin/akeru
RUN mkdir -p /data /workspace node/bin \
  && ln -s /usr/local/bin/node node/bin/node \
  && node -p "require('./package.json').version" > VERSION \
  && chmod 755 remote-admin initialize-remote-identity.sh /usr/local/bin/akeru \
  && chown node:node /data /workspace
USER node
EXPOSE 3773
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null || exit 1
ENTRYPOINT ["akeru"]
CMD ["serve"]
