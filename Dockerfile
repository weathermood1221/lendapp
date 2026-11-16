FROM node:22-slim
ENV NODE_ENV=production TZ=Asia/Kuala_Lumpur DATA_DIR=/app/data PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
# build tools are only a fallback in case the prebuilt SQLite binary can't be downloaded
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev && npm cache clean --force \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
