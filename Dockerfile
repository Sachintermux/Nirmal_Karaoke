# Multi-stage build: dependencies stage
FROM node:22-alpine AS dependencies

WORKDIR /app

# Copy only dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev && npm cache clean --force


# Final production stage: minimal runtime
FROM node:22-alpine

# Install FFmpeg & CA certificates
RUN apk add --no-cache ffmpeg ca-certificates

# Create non-root user for security
RUN addgroup -S appuser && adduser -S appuser -G appuser

WORKDIR /app

# Copy dependencies from builder stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package*.json ./

# Copy application source as non-root user
COPY --chown=appuser:appuser . .

# Switch to non-root user
USER appuser

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); const req = http.get('http://localhost:3000/health', {timeout: 3000}, (res) => process.exit(res.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1));"

# Expose server port
EXPOSE 3000

# Start production server
CMD ["node", "server.js"]
