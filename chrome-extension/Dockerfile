# Pinned to the exact Node version currently deployed - see backend/Dockerfile.
FROM node:26.4.0-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "scripts/watch.js"]
