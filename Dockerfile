# Railway builds from this submodule repository directly.
FROM oven/bun:1.3-slim AS base
WORKDIR /app

# Sharp needs libvips' runtime libraries on Debian slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips42 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json bun.lock ./
COPY contracts/package.json ./contracts/
RUN bun install --frozen-lockfile --production

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY contracts ./contracts
# The contracts package needs `tsc`, which `--production` omits. Install it in
# the build stage only; the runtime stage copies the compiled dist and the
# production node_modules from here.
RUN cd contracts && bun install --frozen-lockfile && bun run build

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/contracts/dist ./contracts/dist
COPY --from=build /app/contracts/package.json ./contracts/package.json
COPY --from=build /app/src ./src
COPY package.json ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Run as a non-root user.
RUN useradd --system --uid 10001 --create-home appuser \
 && chown -R appuser:appuser /app
USER appuser

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
