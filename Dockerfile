# Stage 1: Build TypeScript source code
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production runtime image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install curl for healthcheck probe
RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built JavaScript files and required assets
COPY --from=builder /app/lib ./lib
COPY docs/ ./docs/
COPY db/ ./db/
COPY views/ ./views/
COPY public/ ./public/

# Run as non-root user for container security
USER node

EXPOSE 3000

# Container healthcheck querying our /healthz endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/healthz || exit 1

CMD ["npm", "start"]

