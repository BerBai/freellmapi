FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=8787
ENV CATALOG_DATA_DIR=/data

EXPOSE 8787
CMD ["node", "src/server.mjs"]
