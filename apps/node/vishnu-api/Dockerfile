# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /workspace
COPY . .
# Private registry configuration is a BuildKit secret, never a layer or ARG.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    pnpm --filter @saga-ed/vishnu-api... --filter @saga-ed/vishnu install --frozen-lockfile --ignore-scripts
RUN pnpm exec turbo run build --filter=@saga-ed/vishnu-api^... \
    && pnpm --filter @saga-ed/vishnu-api build \
    && pnpm --filter @saga-ed/vishnu build \
    && pnpm --filter @saga-ed/vishnu-api deploy --prod --ignore-scripts /out/api
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8931 VISHNU_STATIC_DIR=/app/web
WORKDIR /app/api
COPY --from=build --chown=node:node /out/api/ ./
COPY --from=build --chown=node:node /workspace/apps/web/vishnu/build/ /app/web/
USER node
EXPOSE 8931
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8931/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
