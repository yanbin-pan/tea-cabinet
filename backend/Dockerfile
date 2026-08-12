FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# server.js imports from ./lib, so both must land in the image. Copying them
# explicitly rather than `COPY . .` keeps tests and scratch files out — but it
# also means a new top-level source directory has to be added here. Forgetting
# that shipped a CrashLoopBackOff once: the tests all passed because they run
# from the source tree, never from the built image. The `image` job in
# .github/workflows/verify.yaml now boots this image and is what catches it.
COPY server.js ./
COPY lib ./lib

ENV PORT=8080 \
    DATA_DIR=/app/data
EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "server.js"]
