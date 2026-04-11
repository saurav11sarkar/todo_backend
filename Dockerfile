# ── Build stage ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# Copy dependency files first (better Docker layer caching)
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install ALL dependencies (dev deps needed for nest build)
RUN npm ci

# Generate Prisma client BEFORE building
RUN npx prisma generate

# Copy source code and build
COPY . .
RUN npm run build

# ── Production stage ─────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=5000

# Copy package files
COPY package*.json ./

# Install production-only dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy Prisma schema + generated client from build stage
COPY --from=builder /usr/src/app/prisma ./prisma/
COPY --from=builder /usr/src/app/prisma.config.ts ./
COPY --from=builder /usr/src/app/prisma/generated ./prisma/generated

# Copy compiled application from build stage
COPY --from=builder /usr/src/app/dist ./dist

# Run as non-root user for security
USER node

EXPOSE ${PORT}

# Start the application
# Render injects env vars at runtime — no .env file needed
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
