# SystemX

A WebSocket communication router modelled after classic telephone exchanges. SystemX enables agents to register addresses, place calls, exchange messages, and hang up using a minimal JSON protocol.

## Quick Start

```bash
# Install dependencies
bun install

# Start the router
bun run src/server.ts

# Run the example client
bun run examples/simple-client.ts --address alice@example.com --dial bob@example.com
```

The server listens on `SYSTEMX_HOST`/`SYSTEMX_PORT` (defaults: `0.0.0.0:8080`). See `.env.example` for configuration knobs.

## Development

```bash
# Run unit tests
bun test

# Start the router with hot reload during development
bun run --watch src/server.ts
```

### Project Layout

- `src/server.ts` – Bun WebSocket server bootstrap.
- `src/router.ts` – Message routing and state transitions.
- `src/connection.ts` – Connection bookkeeping helpers.
- `src/call.ts` – Call state manager.
- `src/logger.ts` – Structured logging utilities.
- `examples/simple-client.ts` – Interactive example client.
- `docs/SystemX.md` – Full protocol specification.

### Protocol Overview

All messages are JSON objects with a `type` field. Phase 1 supports:

- Registration: `REGISTER`, `REGISTERED`, `REGISTER_FAILED`, `UNREGISTER`
- Presence: `STATUS`
- Liveness: `HEARTBEAT`, `HEARTBEAT_ACK`
- Calls: `DIAL`, `RING`, `ANSWER`, `CONNECTED`, `MSG`, `HANGUP`, `BUSY`

Refer to `docs/SystemX.md` for exhaustive payload definitions and future phases.

## Environment

Copy `.env.example` to `.env` and adjust as needed. Values are read automatically when the server starts.

```bash
SYSTEMX_PORT=8080
SYSTEMX_HOST=0.0.0.0
SYSTEMX_HEARTBEAT_INTERVAL=30000
SYSTEMX_HEARTBEAT_TIMEOUT=60000
SYSTEMX_LOG_LEVEL=info
SYSTEMX_CALL_TIMEOUT=30000
SYSTEMX_DIAL_MAX_ATTEMPTS=10
SYSTEMX_DIAL_WINDOW_MS=60000
```

## Testing Strategy

The repository uses Bun's built-in `bun test`. Current coverage focuses on routing behaviour (registration, heartbeat acks, call flow, stale connection eviction). Extend with integration tests as more features land.
