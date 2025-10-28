Three Types of Recipients (concurrency mode in registration protocol and wake model)

1. Single-Use (Exclusive)
Classic point-to-point call - one caller at a time
Examples:

ceo@home.entrained.ai - can only work on one task at a time
chris@entrained.ai - you're one person, one conversation
studio-mixer@home.entrained.ai - physical device with single user

Behavior:

First caller gets through
Subsequent callers get BUSY (already_in_call)
After HANGUP, available again


2. Multi-Use Broadcast (Shared Session)
One agent, everyone hears the same thing
Examples:

talking-clock@time-services.io - everyone gets the current time
news-feed@bbc.co.uk - broadcasts same feed to all listeners
train-announcements@station.rail.uk - PA system style
radio-station@music.io - streaming broadcast

Behavior:

Multiple callers can DIAL simultaneously
All callers connected to same session
When agent sends MSG, all callers receive it
Callers can't necessarily talk back (one-way broadcast)
Or if two-way, everyone hears everyone (party line style)


3. Multi-Use Separate Sessions (Pooled/Stateless)
Agent spawns separate instance per caller
Examples:

weather-bot@services.io - each caller gets their own query session
alice.busbot@socialmagnetics.io - can chat with multiple people simultaneously
api-gateway@backend.io - handles concurrent requests independently
customer-service@company.io - multiple agents available

Behavior:

Multiple callers can DIAL simultaneously
Each gets their own isolated session
Agent handles each conversation independently
Could be:

Same process/instance (stateless, like HTTP handlers)
Separate spawned instances (via wake-on-ring pooling)
Load-balanced pool (round-robin to available instances)


Registration Syntax
typescript// Single-Use (current default)
{
  "type": "REGISTER",
  "address": "chris@entrained.ai",
  "concurrency": "single"  // or omit, default
}

// Multi-Use Broadcast
{
  "type": "REGISTER",
  "address": "talking-clock@time-services.io",
  "concurrency": "broadcast",
  "max_listeners": 1000  // optional cap
}

// Multi-Use Separate Sessions
{
  "type": "REGISTER",
  "address": "weather-bot@services.io",
  "concurrency": "parallel",
  "max_sessions": 10  // spawn up to 10 instances
}

// Or with wake-on-ring pooling
{
  "type": "REGISTER",
  "address": "alice.busbot@socialmagnetics.io",
  "concurrency": "parallel",
  "mode": "wake_on_ring",
  "pool_size": 5,
  "wake_handler": {...}
}

Routing Logic Changes
typescript// In router when handling DIAL

const callee = connections.get(to);

switch (callee.concurrency) {
  case 'single':
    // Current behavior - check if already in call
    if (isInCall(callee)) {
      return BUSY('already_in_call');
    }
    // Create exclusive call
    break;

  case 'broadcast':
    // Add caller to broadcast listener list
    // Don't create traditional "call" - create "subscription"
    addBroadcastListener(callee, caller);
    return CONNECTED;

  case 'parallel':
    // Check if under max_sessions limit
    if (getActiveSessions(callee) >= callee.max_sessions) {
      return BUSY('max_sessions_reached');
    }
    // Create isolated session (new call_id)
    // If wake_on_ring, spawn new instance if needed
    break;
} and wake model

Call State for Different Types
Single-Use:
typescript{
  callId: "call-123",
  caller: "chris@entrained.ai",
  callee: "ceo@home.entrained.ai",
  state: "connected"
}
Broadcast:
typescript{
  broadcaster: "talking-clock@time-services.io",
  listeners: [
    "chris@entrained.ai",
    "alice@entrained.ai",
    "bob@example.com"
  ]
}
Parallel Sessions:
typescript// Multiple independent calls to same address
{
  callId: "call-456",
  caller: "chris@entrained.ai",
  callee: "weather-bot@services.io",
  sessionId: "session-A"
}
{
  callId: "call-789",
  caller: "alice@entrained.ai",
  callee: "weather-bot@services.io",
  sessionId: "session-B"
}

Wake-on-Ring with Pooling
For parallel sessions with wake-on-ring:
typescript// First caller dials weather-bot (asleep)
DIAL → weather-bot@services.io

// Router spawns instance-1
wake_handler() → spawns weather-bot-instance-1
// Connects caller to instance-1

// Second caller dials (instance-1 busy)
DIAL → weather-bot@services.io

// Router spawns instance-2
wake_handler() → spawns weather-bot-instance-2
// Connects caller to instance-2

// After idle timeout, instances sleep
// Next caller wakes fresh instance
```

---

## Use Cases

**Talking Clock (Broadcast):**
```
100 people dial talking-clock@time-services.io
All connected instantly (no BUSY)
Clock broadcasts: "The time is 20:45"
All 100 people receive same message
```

**Bus Stop Agents (Parallel):**
```
Person A approaches bus stop
Person B approaches same bus stop
Both dial alice.busbot@socialmagnetics.io
Router spawns alice-instance-1 for Person A
Router spawns alice-instance-2 for Person  and wake modelB
Each has independent conversation
```

**CEO (Single):**
```
You dial ceo@home.entrained.ai
Connected, considering tonights dinner reservations and marketing optics
Alice tries to dial same address
Gets BUSY - you're talking to them

This is a really important distinction! Without it, you can't model things like:

Radio stations (broadcast)
Stateless APIs (parallel)
Shared resources (single)

