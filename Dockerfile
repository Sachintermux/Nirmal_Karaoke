# Production Dockerfile for Nirmal Karaoke Backend + FFmpeg RTMP Streaming Relay
FROM node:22-alpine

# Install FFmpeg & CA certificates on Alpine
RUN apk add --no-cache ffmpeg ca-certificates

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000

# Expose server port
EXPOSE 3000

# Start production server
CMD ["node", "server.js"]
