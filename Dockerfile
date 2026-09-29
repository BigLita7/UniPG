FROM node:20-bookworm-slim AS node-runtime

FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/app/certs/russian-trusted-root-ca.pem \
    PORT=8000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY mini_app/requirements.txt ./mini_app/requirements.txt
RUN pip install --no-cache-dir -r mini_app/requirements.txt

COPY bot/package.json bot/package-lock.json* ./bot/
RUN npm --prefix ./bot ci --omit=dev --no-audit --no-fund

COPY mini_app ./mini_app
COPY bot ./bot

COPY certs ./certs

COPY scripts ./scripts
RUN chmod +x ./scripts/start-production.sh

EXPOSE 8000

CMD ["./scripts/start-production.sh"]