FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM nginx:alpine AS serve
RUN apk add --no-cache openssl
COPY --from=build /app/dist /usr/share/nginx/html
# nginx Docker image processes /etc/nginx/templates/*.template via envsubst on startup
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY docker-entrypoint-tls.sh /docker-entrypoint.d/00-tls-setup.sh
RUN chmod +x /docker-entrypoint.d/00-tls-setup.sh
EXPOSE 80 443
