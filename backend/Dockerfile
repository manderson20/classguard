# Pinned to the exact Node version currently deployed - :20-alpine floats to
# whatever's newest in the 20.x line on every rebuild with no diff to review.
FROM node:26.3.1-alpine

RUN apk add --no-cache fping iputils traceroute

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
