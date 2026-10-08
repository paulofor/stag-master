FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213
WORKDIR /workspace
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY src/main/ src/main/
COPY src/shared/ src/shared/
COPY scripts/test-sqlserver.mjs scripts/test-sqlserver.mjs
CMD ["node", "scripts/test-sqlserver.mjs"]
