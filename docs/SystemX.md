# SystemX - WebSocket Communication Router
## Implementation Specification

### Overview

SystemX is a WebSocket-based communication router modeled after traditional telephone exchanges (specifically British Telecom's System X digital exchange). It provides simple, reliable message routing between distributed endpoints using email-style addressing.

**Core Philosophy:** Simple primitives that compose well. Not a message queue, not a pub/sub system - a telephone exchange for the internet.

---

## Technical Requirements

### Platform
- **Runtime:** Bun (for excellent WebSocket support)
- **Language:** TypeScript
- **Protocol:** WebSocket with JSON messages
- **State:** In-memory (Phase 1), Redis-backed (future)

### Dependencies
- Bun built-in WebSocket server
- UUID generation for session/call IDs
- (Optional) dotenv for configuration

---

## Message Protocol

### Message Format
All messages are JSON objects with a `type` field indicating the message kind.

### Connection & Registration

#### REGISTER
Client → Router: Register an address
```json
{
  "type": "REGISTER",
  "address": "user@domain.tld",
  "auth": "optional_token",
  "metadata": {
    "capabilities": ["chat", "code"],
    "location": {"lat": 53.7, "lon": -1.8},
    "status": "available"
  }
}
```

#### REGISTERED
Router → Client: Confirmation
```json
{
  "type": "REGISTERED",
  "address": "user@domain.tld",
  "session_id": "uuid"
}
```

#### REGISTER_FAILED
Router → Client: Registration error
```json
{
  "type": "REGISTER_FAILED",
  "reason": "address_in_use" | "invalid_address" | "auth_failed"
}
```

#### UNREGISTER
Client → Router: Disconnect
```json
{
  "type": "UNREGISTER"
}
```

#### STATUS
Client → Router: Update status
```json
{
  "type": "STATUS",
  "status": "available" | "busy" | "dnd" | "away",
  "auto_sleep": {
    "idle_timeout_seconds": 300,
    "wake_on_ring": true
  }
}
```

#### HEARTBEAT
Client → Router: Keep-alive
```json
{
  "type": "HEARTBEAT"
}
```

#### HEARTBEAT_ACK
Router → Client: Acknowledgment
```json
{
  "type": "HEARTBEAT_ACK",
  "timestamp": 1234567890
}
```

---

### Point-to-Point Calls

#### DIAL
Caller → Router: Initiate call
```json
{
  "type": "DIAL",
  "to": "recipient@domain.tld",
  "metadata": {
    "subject": "Optional subject",
    "priority": "normal" | "high"
  }
}
```

#### RING
Router → Callee: Incoming call
```json
{
  "type": "RING",
  "from": "caller@domain.tld",
  "call_id": "uuid",
  "metadata": {...}
}
```

#### ANSWER
Callee → Router: Accept call
```json
{
  "type": "ANSWER",
  "call_id": "uuid"
}
```

#### CONNECTED
Router → Caller: Call connected
```json
{
  "type": "CONNECTED",
  "call_id": "uuid",
  "to": "recipient@domain.tld"
}
```

#### HANGUP
Either Party → Router: End call
```json
{
  "type": "HANGUP",
  "call_id": "uuid"
}
```
Router → Other Party: Call ended
```json
{
  "type": "HANGUP",
  "call_id": "uuid",
  "reason": "normal" | "timeout" | "error"
}
```

#### BUSY
Router → Caller: Recipient unavailable
```json
{
  "type": "BUSY",
  "to": "recipient@domain.tld",
  "reason": "already_in_call" | "dnd" | "offline" | "no_such_address"
}
```

#### MSG
During Active Call - Either Party → Router
```json
{
  "type": "MSG",
  "call_id": "uuid",
  "data": "message content",
  "content_type": "text" | "json" | "binary"
}
```
Router → Other Party
```json
{
  "type": "MSG",
  "call_id": "uuid",
  "from": "sender@domain.tld",
  "data": "message content",
  "content_type": "text"
}
```

---

### Party Lines (Phase 3)

#### JOIN
Client → Router: Join party line
```json
{
  "type": "JOIN",
  "party": "party.name@domain.tld",
  "create_if_missing": true
}
```

#### JOINED
Router → Client: Confirmation
```json
{
  "type": "JOINED",
  "party": "party.name@domain.tld",
  "participants": ["user1@domain.tld", "user2@domain.tld"]
}
```

#### PARTY_MSG
Client → Router: Message to party
```json
{
  "type": "PARTY_MSG",
  "party": "party.name@domain.tld",
  "data": "message content"
}
```
Router → All Participants
```json
{
  "type": "PARTY_MSG",
  "party": "party.name@domain.tld",
  "from": "sender@domain.tld",
  "data": "message content"
}
```

#### LEAVE
Client → Router: Leave party line
```json
{
  "type": "LEAVE",
  "party": "party.name@domain.tld"
}
```

---

### Discovery & Presence (Phase 4)

#### PRESENCE
Client → Router: Query online addresses
```json
{
  "type": "PRESENCE",
  "query": {
    "domain": "domain.tld",
    "near": {"lat": 53.7, "lon": -1.8, "radius_km": 1},
    "capabilities": ["chat"]
  }
}
```

#### PRESENCE_RESULT
Router → Client: Results
```json
{
  "type": "PRESENCE_RESULT",
  "addresses": [
    {
      "address": "user@domain.tld",
      "status": "available",
      "metadata": {...}
    }
  ]
}
```

---

### Wake-on-Ring (Phase 2 Extension)

#### REGISTER with wake_on_ring
```json
{
  "type": "REGISTER",
  "address": "agent@domain.tld",
  "mode": "wake_on_ring",
  "wake_handler": {
    "type": "webhook" | "spawn",
    "url": "https://spawner.domain.tld/wake/agent",
    "command": ["docker", "run", "agent"],
    "timeout_seconds": 30
  }
}
```

#### SLEEP_PENDING
Router → Client: Idle timeout warning
```json
{
  "type": "SLEEP_PENDING",
  "reason": "idle_timeout",
  "seconds_until_sleep": 30
}
```

#### SLEEP_ACK
Client → Router: Acknowledge sleep
```json
{
  "type": "SLEEP_ACK"
}
```

---

### PBX Federation (Phase 5)

#### REGISTER_PBX
PBX → Parent PBX: Register as downstream
```json
{
  "type": "REGISTER_PBX",
  "domain": "subdomain.domain.tld",
  "routes": ["*.agent@subdomain.domain.tld"],
  "endpoint": "wss://pbx.subdomain.domain.tld",
  "auth": "pbx_token"
}
```

#### DIAL_FORWARD
Parent PBX → Child PBX: Forward call
```json
{
  "type": "DIAL_FORWARD",
  "from": "caller@domain.tld",
  "to": "recipient@subdomain.domain.tld",
  "call_id": "uuid",
  "metadata": {...}
}
```

---

## Core Data Structures

```typescript
interface Connection {
  ws: WebSocket;
  address: string;
  sessionId: string;
  status: 'available' | 'busy' | 'dnd' | 'away';
  metadata: Record<string, any>;
  lastHeartbeat: number;
  autoSleep?: {
    idleTimeoutSeconds: number;
    wakeOnRing: boolean;
  };
  wakeHandler?: {
    type: 'webhook' | 'spawn';
    url?: string;
    command?: string[];
    timeoutSeconds: number;
  };
}

interface Call {
  callId: string;
  caller: string;
  callee: string;
  state: 'ringing' | 'connected' | 'ended';
  startTime: number;
  metadata?: Record<string, any>;
}

interface PartyLine {
  name: string;
  participants: Set<string>;
}

interface RouterState {
  connections: Map<string, Connection>; // address → connection
  calls: Map<string, Call>; // callId → call
  partyLines: Map<string, PartyLine>; // party address → participants
  federatedPBX: Map<string, FederatedPBX>; // domain → PBX info
}
```

---

## Implementation Phases

### Phase 1: Core Router (START HERE)
**Goal:** Basic point-to-point communication working

**Features:**
- WebSocket server listening on configurable port
- REGISTER/UNREGISTER/REGISTERED/REGISTER_FAILED
- HEARTBEAT/HEARTBEAT_ACK with stale connection cleanup
- DIAL/RING/ANSWER/CONNECTED/HANGUP/BUSY
- MSG routing between connected parties
- STATUS updates
- In-memory state only
- Basic error handling
- Logging of all messages (for debugging)

**Deliverables:**
1. `src/server.ts` - Main WebSocket server
2. `src/router.ts` - Message routing logic
3. `src/types.ts` - TypeScript interfaces
4. `src/connection.ts` - Connection management
5. `src/call.ts` - Call state management
6. `package.json` - Dependencies
7. `README.md` - Setup and usage instructions
8. Example client in `examples/simple-client.ts`

**Success Criteria:**
- Two clients can register with different addresses
- Client A can DIAL client B
- Client B receives RING, can ANSWER
- Both clients can send MSG back and forth
- Either client can HANGUP
- Heartbeat keeps connections alive
- Stale connections are cleaned up after 60s without heartbeat

---

### Phase 2: Wake-on-Ring (NEXT)
**Features:**
- Support `mode: "wake_on_ring"` in REGISTER
- Webhook-based wake handlers
- Hold RING while waiting for agent to connect
- Timeout and BUSY if agent doesn't connect
- SLEEP_PENDING warnings for idle agents

---

### Phase 3: Party Lines
**Features:**
- JOIN/JOINED/LEAVE for party lines
- PARTY_MSG fanout to all participants
- Dynamic party line creation

---

### Phase 4: Discovery & Presence
**Features:**
- PRESENCE queries with filtering
- Metadata/location-based search
- Capability matching

---

### Phase 5: Federation & Persistence
**Features:**
- REGISTER_PBX for hierarchical topologies
- DIAL_FORWARD for federated routing
- Redis for state persistence
- Call logs
- Rate limiting

---

## Configuration

Environment variables (`.env`):
```
SYSTEMX_PORT=8080
SYSTEMX_HOST=0.0.0.0
SYSTEMX_HEARTBEAT_INTERVAL=30000
SYSTEMX_HEARTBEAT_TIMEOUT=60000
SYSTEMX_LOG_LEVEL=info
```

---

## Testing Strategy

### Manual Testing (Phase 1)
1. Start router
2. Connect two clients (use `examples/simple-client.ts`)
3. Register both with different addresses
4. Dial from A to B
5. Answer from B
6. Exchange messages
7. Hangup

### Automated Testing (Future)
- Unit tests for routing logic
- Integration tests for call flows
- Load testing for concurrent calls

---

## Error Handling

### Connection Errors
- Invalid address format → REGISTER_FAILED
- Address already in use → REGISTER_FAILED
- Malformed JSON → Close connection with error code

### Call Errors
- Dial to non-existent address → BUSY with "no_such_address"
- Dial to busy address → BUSY with "already_in_call"
- Message to invalid call_id → Ignore (log warning)
- Heartbeat timeout → Auto-UNREGISTER and close connection

---

## Logging

Use structured logging with levels:
- **DEBUG:** All message traffic
- **INFO:** Connections, calls, important state changes
- **WARN:** Errors, timeouts, retries
- **ERROR:** Critical failures

Example:
```
[INFO] Connection registered: alice@example.com (session: abc-123)
[INFO] Call initiated: bob@example.com → alice@example.com (call: def-456)
[DEBUG] MSG: call def-456, 42 bytes
[WARN] Heartbeat timeout: alice@example.com (session: abc-123)
```

---

## Security Considerations (Future)

- **Authentication:** Token-based auth in REGISTER
- **Authorization:** Per-domain access control
- **Rate Limiting:** Prevent spam dialing
- **Encryption:** TLS for WebSocket (wss://)
- **Input Validation:** Sanitize all addresses and metadata

---

## Project Structure

```
systemx/
├── src/
│   ├── server.ts           # Main entry point, WebSocket server
│   ├── router.ts           # Core routing logic
│   ├── connection.ts       # Connection management
│   ├── call.ts             # Call state management
│   ├── types.ts            # TypeScript interfaces
│   ├── logger.ts           # Structured logging
│   └── utils.ts            # Helper functions
├── examples/
│   ├── simple-client.ts    # Basic client example
│   └── README.md           # How to run examples
├── tests/                  # Future tests
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## README Template

```markdown
# SystemX

A WebSocket communication router modeled after telephone exchanges.

## Quick Start

```bash
# Install dependencies
bun install

# Start router
bun run src/server.ts

# In another terminal, run example client
bun run examples/simple-client.ts
```

## Concept

SystemX is a simple, reliable message router using email-style addressing.
Named after British Telecom's System X digital exchange.

## Protocol

See PROTOCOL.md for full message specification.

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

## Development

Built with Bun and TypeScript. See docs/ for architecture details. (Dockerized for server deployments)
```

---

## Success Metrics

**Phase 1 Complete When:**
- Router runs and accepts WebSocket connections
- Two clients can register, dial, connect, message, and hangup
- Heartbeat mechanism works
- Basic logging shows all activity
- Example client demonstrates usage
- README has clear setup instructions

---