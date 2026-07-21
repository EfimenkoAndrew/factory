# factory-exporter — zero-dependency Node service (spine AD-4/AD-5). Pinned base, never :latest.
FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
COPY lib ./lib
USER node
EXPOSE 9464
CMD ["node", "server.mjs"]
