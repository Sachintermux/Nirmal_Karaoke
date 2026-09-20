# Production Dockerfile for Nirmal Karaoke Backend + FFmpeg RTMP Streaming Relay
FROM node:22-bullseye-slim

# Install ffmpeg and required audio libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies (including ws and livekit-server-sdk)
RUN npm ci --only=production

# Copy application source code
COPY . .

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000

# Expose server port
EXPOSE 3000

# Start production server
CMD ["node", "server.js"]
