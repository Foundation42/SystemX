# syntax=docker/dockerfile:1.4
FROM oven/bun:1.3

WORKDIR /app

# Install dependencies first to leverage Docker layer caching
COPY bun.lock package.json ./
RUN bun install

# Copy the rest of the source code
COPY . .

ENV SYSTEMX_PORT=8080 \
    SYSTEMX_HOST=0.0.0.0

EXPOSE 8080

CMD ["bun", "run", "src/server.ts"]
