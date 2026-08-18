FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

# Build-time only. Vite bakes this into the bundle, so a local-only frontend is a
# different image rather than the same one started with a different environment —
# setting it on a running container does nothing.
ARG VITE_LOCAL_ONLY=""
ENV VITE_LOCAL_ONLY=$VITE_LOCAL_ONLY

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
