ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY license-server/package.json license-server/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY license-server/tsconfig.json ./
COPY license-server/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node license-server/public ./public
COPY --chown=node:node license-server/scripts/init.mjs ./scripts/init.mjs
COPY --chown=node:node license-server/client ./client
COPY LICENSE /LICENSE
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
