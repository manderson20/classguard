FROM node:20-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD sh -c "npm run build && mkdir -p /output && rm -f /output/classguard-extension.zip && cd dist && zip -rq /output/classguard-extension.zip ."
