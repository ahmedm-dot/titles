# Self-hosted promptfoo UI with a password gate, for Render (see render.yaml at repo root).
FROM node:22-slim

# Keep this version in sync with llm-eval/package.json so `promptfoo share` uploads match the server.
RUN npm install -g promptfoo@0.123.1 && npm cache clean --force

WORKDIR /app
COPY auth-proxy.mjs ./

# /data is the Render persistent disk: the results database lives there and survives deploys.
ENV PROMPTFOO_CONFIG_DIR=/data \
    PROMPTFOO_SELF_HOSTED=1 \
    PROMPTFOO_DISABLE_TELEMETRY=1 \
    PROMPTFOO_DISABLE_UPDATE=1 \
    NODE_ENV=production \
    PORT=10000
EXPOSE 10000

CMD ["node", "auth-proxy.mjs"]
