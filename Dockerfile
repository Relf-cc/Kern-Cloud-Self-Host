# Kern self-hosted server.
#
# Two stages so the image carries no compiler and no dev dependencies. The
# version is passed in at build time and is what the management API reports, so
# `kernctl status` can tell you what is actually running.
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ARG VERSION=dev
ENV NODE_ENV=production
ENV KERN_SERVER_VERSION=$VERSION
WORKDIR /app
RUN addgroup -S kern && adduser -S kern -G kern
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./
# Where the bootstrap management token is written, and where kernctl looks for
# it. Mounted as a volume by docker-compose so it survives a rebuild.
RUN mkdir -p /var/lib/kern && chown kern:kern /var/lib/kern
ENV ADMIN_TOKEN_FILE=/var/lib/kern/admin-token
USER kern
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/kern/v1/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
