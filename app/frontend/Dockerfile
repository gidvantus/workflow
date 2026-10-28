# Сборка: зависимости отдельным слоем, чтобы правки в src не пересобирали npm ci.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# build = tsc --noEmit && vite build: типы проверяются до сборки статики.
RUN npm run build

# Раздача статики и проксирование /api на сервис api: фронт ходит на свой же origin.
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
