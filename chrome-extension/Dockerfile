FROM node:20-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "scripts/watch.js"]
