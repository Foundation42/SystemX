# SystemX

**A WebSocket communication router that works just like a telephone exchange.**

No complex pub/sub patterns. No confusing message brokers. Just the familiar simplicity of a phone call:
- **REGISTER** your address
- **DIAL** who you want to talk to
- **ANSWER** when someone calls
- Exchange **MSG** back and forth
- **HANGUP** when you're done

That's it. Five message types. Infinite possibilities.

## Why a Telephone Exchange?

Because everyone already understands how a telephone works.

```
Want to talk to someone?  → Pick up the phone and DIAL
They answer?              → You're CONNECTED
Say something?            → Send a MSG
Done?                     → HANGUP
```

This metaphor scales from simple 1-on-1 calls to complex scenarios like broadcast (party lines), concurrent calls (call waiting), and even federation (connecting multiple exchanges). All using the same intuitive protocol.

## Quick Start

```bash
# Install dependencies
bun install

# Start the exchange
bun run src/server.ts

# In another terminal, try the demo agents
bun run demo-agent-helper.ts      # Waits for calls
bun run demo-agent-curious.ts     # Calls the helper and asks questions
```

The server listens on `ws://localhost:8080` by default. See `.env.example` for configuration.

## Live Examples

### Simple Conversation

Two agents having a chat:

```bash
# Terminal 1: Start a helpful agent
bun run demo-agent-helper.ts

# Terminal 2: Start a curious agent that calls the helper
bun run demo-agent-curious.ts
```

Watch them:
- Register on the exchange
- Place a call
- Have a 4-turn conversation
- Hang up gracefully

### Broadcast (Party Line)

A talking clock broadcasting to multiple listeners:

```bash
# Terminal 1: Start the talking clock
bun run demo-talking-clock.ts

# Terminal 2, 3, 4: Multiple listeners dial in
bun run examples/simple-client.ts --address alice@listeners.io --dial talking-clock@time-services.io
bun run examples/simple-client.ts --address bob@listeners.io --dial talking-clock@time-services.io
bun run examples/simple-client.ts --address charlie@listeners.io --dial talking-clock@time-services.io
```

All listeners hear:
- The same time announcements
- Each other joining the call
- Everything on the shared "party line"

### Custom Client

Use the interactive client for quick tests:

```bash
bun run examples/simple-client.ts --address you@example.com --dial friend@example.com
```

## What You Can Build

**Because it's just a telephone exchange, the use cases are endless:**

- **Multi-agent systems** - Agents calling each other to collaborate
- **IoT device communication** - Home devices registering and calling each other
- **Broadcast services** - One agent (weather, news) broadcasting to many listeners
- **NAT traversal via federation** - Child exchanges connecting back to parent
- **Wake-on-ring** - Agents sleeping until someone calls them
- **Conference calls** - Multiple agents on the same call

## Key Features

- **Simple Protocol:** 5 core message types (REGISTER, DIAL, ANSWER, MSG, HANGUP)
- **Concurrency Modes:**
  - `single` - One caller at a time (exclusive)
  - `broadcast` - Multiple listeners, shared session (party line)
  - `parallel` - Multiple separate sessions (like a call center)
- **Wake-on-Ring:** Agents can sleep and wake via webhooks/spawn
- **Federation:** Child PBXs connect to parent exchanges
- **Rate Limiting:** Configurable dial throttling
- **TLS Support:** Secure WebSocket connections (wss://)

## Protocol at a Glance

All messages are JSON with a `type` field:

```javascript
// Register on the exchange
{ "type": "REGISTER", "address": "alice@example.com" }

// Call someone
{ "type": "DIAL", "to": "bob@example.com" }

// Answer incoming call
{ "type": "ANSWER", "call_id": "..." }

// Send a message during the call
{ "type": "MSG", "call_id": "...", "data": "Hello!" }

// End the call
{ "type": "HANGUP", "call_id": "..." }
```

See `docs/SystemX.md` for the complete specification.

## Development

```bash
# Run all tests
bun test

# Start with hot reload
bun run --watch src/server.ts

# Test specific scenarios
bun test --test-name-pattern pbx
```

**Test coverage:** 63 tests covering point-to-point calls, concurrent calls, broadcast, federation, wake-on-ring, and error handling.

## Docker Deployment

```bash
# Build and run
docker build -t systemx .
docker run --rm -p 8080:8080 systemx

# With docker-compose
docker compose up --build
```

### Production with TLS

```bash
docker run --rm -p 8080:8080 \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -e TLS_ENABLED=true \
  -e TLS_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem \
  -e TLS_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem \
  systemx
```

## Configuration

Copy `.env.example` to `.env` and customize:

```bash
SYSTEMX_PORT=8080
SYSTEMX_HOST=0.0.0.0
SYSTEMX_HEARTBEAT_INTERVAL=30000
SYSTEMX_HEARTBEAT_TIMEOUT=60000
SYSTEMX_CALL_TIMEOUT=30000
SYSTEMX_DIAL_MAX_ATTEMPTS=10
SYSTEMX_DIAL_WINDOW_MS=60000
SYSTEMX_LOG_LEVEL=info

# TLS (optional)
TLS_ENABLED=false
TLS_CERT_PATH=/path/to/cert.pem
TLS_KEY_PATH=/path/to/key.pem
```

## Project Structure

```
src/
  server.ts         - WebSocket server bootstrap
  router.ts         - Message routing & state management
  connection.ts     - Connection lifecycle
  call.ts           - Call state machine
  logger.ts         - Structured logging
  wake.ts           - Wake-on-ring handlers

examples/
  simple-client.ts  - Interactive CLI client

demo-agent-*.ts     - Working demo agents
docs/               - Full protocol documentation
tests/              - Comprehensive test suite
```

## Documentation

- **`docs/SystemX.md`** - Complete protocol specification
- **`docs/RecipientTypes.md`** - Concurrency modes explained
- **`docs/FederatedTests.md`** - Federation scenarios

## Licensing

This project uses a **dual licensing model**:

- **MIT License** - Free for individuals, education, and community projects
- **Commercial License** - For proprietary or revenue-generating use

If your organization uses SystemX in a product, service, or platform, please reach out: **license@foundation42.org**

See [LICENSE](LICENSE) and [LICENSE-MIT](LICENSE-MIT) for details.

## Why "SystemX"?

Named after the Cleckheaton telephone exchange in Yorkshire, which used System X switching technology in the 1980s. Just as that exchange connected a town, this SystemX connects agents across the internet using the same timeless metaphor: the telephone call.

---

**Built with ❤️ using [Bun](https://bun.sh)** • **Questions?** Open an issue!
