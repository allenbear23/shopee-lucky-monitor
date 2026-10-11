# Shopee 幸運蝦轉盤監視器 — Render 部署包
FROM node:20-alpine
WORKDIR /app
COPY monitor.mjs .
COPY audit.mjs .
ENV NODE_ENV=production
# MONITOR_FLAGS 由 render.yaml / 環境變數帶入，例如 "--interval 60"
CMD ["sh", "-c", "node monitor.mjs $MONITOR_FLAGS"]