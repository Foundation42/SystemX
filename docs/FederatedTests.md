
## Federation Test Scenarios

### 18. Basic PBX-to-PBX Registration
**Scenario:** Home PBX registers with cloud exchange

```
Cloud PBX running at: wss://exchange.entrained.ai

Home PBX (behind NAT/firewall) connects outbound:
home-pbx connects to wss://exchange.entrained.ai

home-pbx → REGISTER_PBX {
  domain: "home.entrained.ai",
  routes: ["*.home.entrained.ai"],
  endpoint: "internal",  // "internal" means keep this WebSocket connection
  auth: "home_pbx_secret_token"
}

exchange.entrained.ai ← REGISTER_PBX
exchange.entrained.ai: Add route: *.home.entrained.ai → (this WebSocket)
exchange.entrained.ai → REGISTERED_PBX {
  domain: "home.entrained.ai",
  status: "connected"
}

(Now home PBX is a child of cloud exchange)
```

---

### 19. Federated Call: Cloud → Home
**Scenario:** Someone on cloud exchange dials into home network

```
Topology:
  Cloud Exchange (exchange.entrained.ai)
    └─ Home PBX (home.entrained.ai) - behind firewall
         └─ claude-code@home.entrained.ai (registered locally)

alice@entrained.ai (on cloud) → DIAL → claude-code@home.entrained.ai

Cloud Exchange:
  - Checks local connections: No claude-code@home.entrained.ai
  - Checks routes: *.home.entrained.ai → Home PBX connection
  - Forwards DIAL down the WebSocket to Home PBX

Cloud → Home PBX: DIAL_FORWARD {
  from: "alice@entrained.ai",
  to: "claude-code@home.entrained.ai",
  call_id: "cloud-call-123",
  metadata: {...}
}

Home PBX:
  - Receives DIAL_FORWARD
  - Checks local connections: Found claude-code@home.entrained.ai
  - Sends RING locally

Home PBX → claude-code@home.entrained.ai: RING {
  from: "alice@entrained.ai",
  call_id: "cloud-call-123"
}

claude-code@home.entrained.ai → Home PBX: ANSWER

Home PBX → Cloud: ANSWER {
  call_id: "cloud-call-123"
}

Cloud → alice@entrained.ai: CONNECTED

(MSG traffic flows: alice ↔ Cloud ↔ Home PBX ↔ claude-code)

alice → Cloud: MSG "Please fix bug in auth.ts"
Cloud → Home PBX: MSG (call_id: cloud-call-123)
Home PBX → claude-code: MSG "Please fix bug in auth.ts"

claude-code → Home PBX: MSG "Looking at it now..."
Home PBX → Cloud: MSG
Cloud → alice: MSG "Looking at it now..."
```

---

### 20. Federated Call: Home → Cloud
**Scenario:** Device on home network dials someone on cloud exchange

```
studio-controller@home.entrained.ai (on Home PBX)
  wants to dial →
alice@entrained.ai (on Cloud Exchange)

studio-controller → Home PBX: DIAL {
  to: "alice@entrained.ai"
}

Home PBX:
  - Checks local connections: No alice@entrained.ai locally
  - Checks if it's a child PBX: Yes, parent is Cloud Exchange
  - Forwards DIAL upstream

Home PBX → Cloud: DIAL_FORWARD {
  from: "studio-controller@home.entrained.ai",
  to: "alice@entrained.ai",
  call_id: "home-call-456"
}

Cloud Exchange:
  - Receives DIAL_FORWARD
  - Checks local connections: Found alice@entrained.ai
  - Delivers RING

Cloud → alice@entrained.ai: RING {
  from: "studio-controller@home.entrained.ai",
  call_id: "home-call-456"
}

alice → Cloud: ANSWER
Cloud → Home PBX: CONNECTED
Home PBX → studio-controller: CONNECTED

(Call proceeds with messages proxied through Home PBX and Cloud)
```

---

### 21. Home PBX Reconnection
**Scenario:** Home PBX loses connection and reconnects

```
Home PBX connected to Cloud Exchange
claude-code@home.entrained.ai is registered on Home PBX
alice@entrained.ai (on Cloud) is in active call with claude-code

(Home PBX WebSocket disconnects - network hiccup)

Cloud Exchange:
  - Detects Home PBX WebSocket closed
  - [WARN] Federated PBX disconnected: home.entrained.ai
  - Sends HANGUP to alice@entrained.ai (reason: error)
  - Removes routes for *.home.entrained.ai

(30 seconds later, Home PBX reconnects)

Home PBX → Cloud: REGISTER_PBX {
  domain: "home.entrained.ai",
  routes: ["*.home.entrained.ai"]
}

Cloud Exchange:
  - Re-establishes routes
  - [INFO] Federated PBX reconnected: home.entrained.ai

(alice can dial claude-code again)
```

---

### 22. Multi-Level Hierarchy
**Scenario:** Cloud → Regional → Home topology

```
Topology:
  Cloud Exchange (exchange.entrained.ai)
    └─ Regional PBX (yorkshire.socialmagnetics.io)
         └─ Home PBX (home.entrained.ai)
              └─ local-agent@home.entrained.ai

Regional PBX connects to Cloud:
regional-pbx → Cloud: REGISTER_PBX {
  domain: "yorkshire.socialmagnetics.io",
  routes: ["*.yorkshire.socialmagnetics.io", "*.home.entrained.ai"]
}

Home PBX connects to Regional:
home-pbx → Regional: REGISTER_PBX {
  domain: "home.entrained.ai", 
  routes: ["*.home.entrained.ai"]
}

Now someone on Cloud dials home:
alice@entrained.ai → DIAL → local-agent@home.entrained.ai

Cloud Exchange:
  - Checks routes: *.home.entrained.ai → Regional PBX
  - Forwards DIAL_FORWARD to Regional

Cloud → Regional: DIAL_FORWARD

Regional PBX:
  - Checks routes: *.home.entrained.ai → Home PBX
  - Forwards DIAL_FORWARD to Home

Regional → Home: DIAL_FORWARD

Home PBX:
  - Checks local: Found local-agent@home.entrained.ai
  - Delivers RING

(Messages flow through all three hops)
```

---

### 23. Route Conflict Resolution
**Scenario:** Two child PBXs try to register overlapping routes

```
PBX-A → Cloud: REGISTER_PBX {
  domain: "network-a.example.com",
  routes: ["*.example.com"]
}

Cloud: Registered PBX-A with routes *.example.com

PBX-B → Cloud: REGISTER_PBX {
  domain: "network-b.example.com", 
  routes: ["*.example.com"]
}

Cloud: [ERROR] Route conflict: *.example.com already claimed by PBX-A

Cloud → PBX-B: REGISTER_PBX_FAILED {
  reason: "route_conflict",
  conflicting_route: "*.example.com",
  claimed_by: "network-a.example.com"
}
```

---

### 24. Federated Busy Signal
**Scenario:** Agent on home network is busy when cloud caller dials

```
claude-code@home.entrained.ai is in call with bob@home.entrained.ai

alice@entrained.ai (on Cloud) → DIAL → claude-code@home.entrained.ai

Cloud → Home PBX: DIAL_FORWARD
Home PBX checks: claude-code is in active call

Home PBX → Cloud: BUSY {
  call_id: "cloud-call-789",
  reason: "already_in_call"
}

Cloud → alice@entrained.ai: BUSY {
  to: "claude-code@home.entrained.ai",
  reason: "already_in_call"
}
```

---

### 25. Federated Presence Query
**Scenario:** Query agents across federated PBXs

```
alice@entrained.ai (on Cloud) → PRESENCE {
  query: {
    domain: "home.entrained.ai"
  }
}

Cloud Exchange:
  - Checks routes: *.home.entrained.ai → Home PBX
  - Forwards PRESENCE query

Cloud → Home PBX: PRESENCE_QUERY {
  query: {domain: "home.entrained.ai"},
  reply_to: "alice@entrained.ai"
}

Home PBX:
  - Gathers local connections matching query
  - Returns results

Home PBX → Cloud: PRESENCE_RESULT {
  addresses: [
    {address: "claude-code@home.entrained.ai", status: "available"},
    {address: "studio-controller@home.entrained.ai", status: "available"}
  ]
}

Cloud → alice@entrained.ai: PRESENCE_RESULT {
  addresses: [...]
}
```

---

### 26. Home Network Party Line
**Scenario:** Party line hosted on home PBX, accessible from cloud

```
Party line: party.dev-team@home.entrained.ai (on Home PBX)

alice@entrained.ai (on Cloud) → JOIN party.dev-team@home.entrained.ai

Cloud → Home PBX: JOIN_FORWARD {
  from: "alice@entrained.ai",
  party: "party.dev-team@home.entrained.ai"
}

Home PBX:
  - Creates/joins party line locally
  - Adds alice as remote participant

Home PBX → Cloud: JOINED {
  party: "party.dev-team@home.entrained.ai",
  participants: ["alice@entrained.ai", "bob@home.entrained.ai"]
}

alice → Cloud: PARTY_MSG "Hello team"
Cloud → Home PBX: PARTY_MSG
Home PBX: Fanout to local participants
Home PBX → bob@home.entrained.ai: PARTY_MSG from alice

bob → Home PBX: PARTY_MSG "Hey Alice!"
Home PBX → Cloud: PARTY_MSG
Cloud → alice: PARTY_MSG from bob
```

---

### 27. NAT Traversal Success Story
**Scenario:** Why federation solves the NAT problem

```
Problem without federation:
  - Home devices behind NAT
  - Can't accept inbound connections
  - Phone can't directly reach claude-code@home

Solution with federation:
  1. Home PBX connects OUTBOUND to Cloud (NAT allows this)
  2. WebSocket stays open (persistent connection)
  3. Cloud sends calls DOWN the existing connection
  4. No inbound ports needed on home network!

Result:
  Phone → Cloud Exchange → Home PBX → Claude Code
  (All connections originated from inside the firewall)
```

---

### 28. Authentication Handoff
**Scenario:** Home PBX trusts Cloud's authentication

```
alice@entrained.ai (authenticated at Cloud) calls home

Cloud → Home PBX: DIAL_FORWARD {
  from: "alice@entrained.ai",
  to: "secure-device@home.entrained.ai",
  metadata: {
    authenticated_by: "exchange.entrained.ai",
    auth_level: "verified",
    timestamp: "2025-10-28T20:30:00Z"
  }
}

Home PBX:
  - Trusts Cloud's authentication
  - Allows call to proceed without re-auth
  - secure-device can trust the caller identity
```

---

These federation scenarios show how powerful the hierarchical model is - your home network becomes a first-class participant in the global SystemX network, even behind NAT/firewall! 

The key insight is: **child PBXs connect outbound to parents, then parents route calls down the existing connection**. No port forwarding, no VPN, just works.
