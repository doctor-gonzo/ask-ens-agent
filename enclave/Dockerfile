# syntax=docker/dockerfile:1.7
# Ask ENS Agent: the Phala dstack (TEE) container, also runnable locally.
# Build from the ask-ens-agent folder: docker build -f enclave/Dockerfile .
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Only the service code: .dockerignore admits nothing else (no keys, data or app build).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY lib ./lib
COPY enclave/server.mjs ./enclave/
COPY skill ./skill
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790 DATA_DIR=/data
EXPOSE 8790
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "enclave/server.mjs"]
