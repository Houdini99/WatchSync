# Stage 1: fetch vendor JS libs into /vendor
FROM alpine:3.20 AS vendor
RUN apk add --no-cache curl
WORKDIR /vendor
RUN curl -fsSL -o hls.min.js https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js && \
    curl -fsSL -o purify.min.js https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js

# Stage 2: nginx serving static client
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
COPY --from=vendor /vendor/hls.min.js   /usr/share/nginx/html/lib/hls.min.js
COPY --from=vendor /vendor/purify.min.js /usr/share/nginx/html/lib/purify.min.js
EXPOSE 80
