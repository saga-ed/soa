# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /workspace
COPY . .
# CodeArtifact token is a BuildKit secret, never a layer or ARG. .npmrc is
# dockerignored, so it is written and deleted inside this RUN.
RUN --mount=type=secret,id=codeartifact,required=true \
    CODEARTIFACT_AUTH_TOKEN="$(cat /run/secrets/codeartifact)" && \
    echo "@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/" > .npmrc && \
    echo "//saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=${CODEARTIFACT_AUTH_TOKEN}" >> .npmrc && \
    pnpm --filter @saga-ed/vishnu-api... --filter @saga-ed/vishnu install --frozen-lockfile --ignore-scripts && \
    rm -f .npmrc
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
