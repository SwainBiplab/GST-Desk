# The API image. Build from the repository root: `docker build -f infra/Dockerfile .`
# Stage 1 installs and bundles with pnpm; stage 2 is distroless Node 22 with only the bundle.

FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY scripts ./scripts
COPY tools ./tools
COPY tests ./tests
# the web and desktop apps are not part of this image; their manifests keep the lockfile valid
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN pnpm install --frozen-lockfile --filter api... --ignore-scripts
# one file with every workspace package inside; node_modules keeps only the native and heavy parts
RUN pnpm --filter api exec node scripts/bundle.mjs \
  && pnpm --filter api deploy --legacy --prod /out \
  && cp -r apps/api/dist /out/dist \
  && cp -r apps/api/migrations /out/migrations

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build --chown=nonroot:nonroot /out /app
EXPOSE 8787
USER nonroot
CMD ["dist/main.mjs"]
