# Multi-architecture, digest-pinned runtimes. No credentials or node_modules in the build.
FROM ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 AS foundry
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
# HTTPS roots are present in the official Foundry image.
COPY --from=foundry /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY indexer/*.mjs ./indexer/
COPY apps/terminal/index.html ./apps/terminal/index.html
COPY contracts/deployments/*-v3.json ./contracts/deployments/
COPY scripts/container-entrypoint.mjs ./scripts/
RUN mkdir -p /data /home/node/.foundry/keystores && chown node:node /data /home/node/.foundry/keystores
USER node
ENV SOURCE=bitcoin PORT=8789 DATA_DIR=/data CAST=/usr/local/bin/cast
EXPOSE 8789
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
CMD ["indexer"]
