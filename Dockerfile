# Pinned for reproducible builds (was floating oven/bun:1). Bun's native-side
# ReadableStream leak fix (PR #30875) has NOT shipped in a stable release as of
# 1.3.14 — bump this when it does. The /mcp dispatcher rewrite (2026-08-02)
# removes per-request allocation, so we aren't exposed to it in the meantime.
FROM oven/bun:1.3.14 AS base
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
