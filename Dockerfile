FROM node:18-alpine

WORKDIR /app

# curl for health check
RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY config/ ./config/
COPY public/ ./public/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "src/index.js"]
