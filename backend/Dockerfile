FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080 \
    DATA_DIR=/app/data
EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "server.js"]
