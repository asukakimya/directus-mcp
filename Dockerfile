# ----- build deps -----
FROM node:22-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ----- runtime -----
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=base /app/dist ./dist

# Default transport is streamable-http (production). Override via env
# (e.g. MCP_TRANSPORT=stdio) for local debug / spawn-from-MCP-client use.
ENV MCP_TRANSPORT=streamable-http
ENV MCP_HTTP_PORT=3333
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
