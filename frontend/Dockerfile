FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Fills NGINX_LOCAL_RESOLVERS from resolv.conf, for the resolver in the template.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
EXPOSE 80
