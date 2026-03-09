FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY . .

# Expose port (Railway sets PORT env var)
EXPOSE 3000

# Start the server
CMD ["bun", "run", "src/index.ts"]
