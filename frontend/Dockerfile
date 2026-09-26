# ---- Stage 1: build the static assets ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
# Copy only what the Vite build reads, rather than `COPY . .`. nginx.conf and
# security-headers.conf live in this same directory but are consumed by stage 2
# only -- with a blanket copy, editing either invalidated this layer and
# re-ran the whole build for a file this stage never opens.
COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- Stage 2: serve via Nginx (also reverse-proxies /api and /ws) ----
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Included by every location block in nginx.conf (see the comment in that file
# for why it cannot just be set once at server level).
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
