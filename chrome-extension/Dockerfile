# Pinned to the exact Node version currently deployed - see backend/Dockerfile.
FROM node:26.10.0-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY package*.json ./
# patches/ must be in place before the install: postinstall runs
# patch-package, and without it crx stays unpatched (its archiver@8 shim) and
# every build fails with "archiver is not a function". This used to be masked
# by COPY . . dragging in the host's already-patched node_modules, which
# .dockerignore now (rightly) excludes.
COPY patches ./patches
RUN npm install
COPY . .
CMD ["node", "scripts/watch.js"]
