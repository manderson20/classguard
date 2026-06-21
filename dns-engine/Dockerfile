# Pinned to the exact Node version currently deployed - see backend/Dockerfile.
FROM node:20.20.2-alpine

# Allow binding to privileged port 53 without running as root
RUN apk add --no-cache libcap && \
    setcap 'cap_net_bind_service=+ep' /usr/local/bin/node

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 53/udp
EXPOSE 53/tcp
EXPOSE 3053

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3053/health || exit 1

CMD ["node", "src/index.js"]
