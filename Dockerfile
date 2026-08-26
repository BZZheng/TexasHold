ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY index.html vite.config.js tokens.css ./
COPY src ./src
COPY shared ./shared
COPY public ./public
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=7790
ENV DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 7790
CMD ["node", "server/index.js"]
