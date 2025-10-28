# SystemX

A WebSocket communication router modelled after classic telephone exchanges. SystemX enables agents to register addresses, place calls, exchange messages, and hang up using a minimal JSON protocol.

## Licensing

This project uses a **dual licensing model**:

- **Open Source (MIT)** for individuals, education, and community projects.
- **Commercial License** for proprietary or revenue-generating use.

If your organization uses this code in a product, service, or platform, please reach out to discuss a suitable commercial arrangement: **license@foundation42.org**

See [LICENSE](LICENSE) and [LICENSE-MIT](LICENSE-MIT) for details.

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

## Features

- **Addressable Calls:** `REGISTER`, `DIAL`, `RING`, `ANSWER`, `MSG`, `HANGUP`, `BUSY`.
- **Presence & Status:** dynamic status updates plus presence queries (`PRESENCE`).
- **Wake-on-Ring & Auto-Sleep:** agents can hibernate with `SLEEP_ACK`, wake via webhooks/spawn handlers, and auto-sleep on idle.
- **Concurrency Modes:** single-use, broadcast, or parallel sessions per address.
- **Federation:** child PBXs register via `REGISTER_PBX`, forwarding calls across exchanges with `DIAL_FORWARD`.
- **Rate Limiting & Timeouts:** configurable dial throttling and ring / idle timers.

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
- Sleep/Wake: `SLEEP_ACK`, `REGISTER` with `mode: "wake_on_ring"`, optional wake handlers
- Federation: `REGISTER_PBX`, `DIAL_FORWARD`, and federated `RING`/`BUSY` relays
- Concurrency: `concurrency: "single" | "broadcast" | "parallel"` with optional caps (`max_listeners`, `max_sessions`)

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

See `docs/RecipientTypes.md` for concurrency examples and `docs/FederatedTests.md` for federated routing scenarios.

## Docker

Build and run the router container:

```bash
docker build -t systemx .
docker run --rm -p 8080:8080 systemx
```

Override configuration via environment variables, e.g.:

```bash
docker run --rm -p 8080:8080 \
  -e SYSTEMX_PORT=8080 \
  -e SYSTEMX_LOG_LEVEL=debug \
  systemx
```

### TLS/SSL Support

SystemX supports TLS for secure WebSocket connections (wss://). Mount your certificates and set the TLS environment variables:

```bash
docker run --rm -p 8080:8080 \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -e TLS_ENABLED=true \
  -e TLS_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem \
  -e TLS_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem \
  systemx
```

### Docker Compose

A simple compose file is provided:

```bash
docker compose up --build
```

This starts the `systemx` service on port `8080`. A template for spawning a child PBX is included (commented) to aid federation experiments; uncomment and adjust the environment/routes as needed.

## Testing Strategy

The repository uses Bun's built-in `bun test`. Coverage spans unit and integration flows (wake-on-ring, concurrency modes, PBX federation).

```bash
bun test                           # run full suite
bun test --test-name-pattern pbx   # target specific scenarios
```
