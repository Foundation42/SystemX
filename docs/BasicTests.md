Oh absolutely! Good test scenarios will help shake out the edge cases. Let's think through some realistic exchanges:

---

## Test Scenarios for SystemX

### 1. Simple Chat Session
**Scenario:** Two humans having a quick conversation

```
Chris registers: chris@entrained.ai
Alice registers: alice@entrained.ai

chris@entrained.ai → DIAL → alice@entrained.ai
alice@entrained.ai ← RING
alice@entrained.ai → ANSWER
chris@entrained.ai ← CONNECTED

chris: "Hey, got a minute?"
alice: "Sure, what's up?"
chris: "Can you review that PSAM PR?"
alice: "On it now, looks good!"
chris: "Cheers!"

chris@entrained.ai → HANGUP
alice@entrained.ai ← HANGUP (reason: normal)
```

---

### 2. Busy Signal
**Scenario:** Alice is already on a call when Bob tries to dial

```
Alice is on call with Chris (call_id: abc-123)

bob@example.com → DIAL → alice@entrained.ai
bob@example.com ← BUSY (reason: already_in_call)

Bob waits 30 seconds...

bob@example.com → DIAL → alice@entrained.ai
alice@entrained.ai ← RING
(Alice answers, call proceeds)
```

---

### 3. No Answer / Timeout
**Scenario:** Dialing someone who's registered but not responding

```
agent.sleepy@socialmagnetics.io is registered but idle

chris@entrained.ai → DIAL → agent.sleepy@socialmagnetics.io
agent.sleepy@socialmagnetics.io ← RING

(30 seconds pass, no ANSWER)

chris@entrained.ai ← BUSY (reason: timeout)
```

---

### 4. Wrong Address / No Such User
**Scenario:** Dialing someone who doesn't exist

```
chris@entrained.ai → DIAL → nobody@nowhere.void
chris@entrained.ai ← BUSY (reason: no_such_address)
```

---

### 5. Do Not Disturb
**Scenario:** User has set DND status

```
alice@entrained.ai → STATUS (status: dnd)

bob@example.com → DIAL → alice@entrained.ai
bob@example.com ← BUSY (reason: dnd)
```

---

### 6. Heartbeat Failure & Auto-Disconnect
**Scenario:** Client loses connection without proper HANGUP

```
chris@entrained.ai registers (session: xyz-789)
chris@entrained.ai → HEARTBEAT
Router → HEARTBEAT_ACK

(60 seconds pass, no heartbeat)

Router: [WARN] Heartbeat timeout: chris@entrained.ai (session: xyz-789)
Router: Auto-UNREGISTER chris@entrained.ai
Router: Close WebSocket connection

(If Chris was in a call)
alice@entrained.ai ← HANGUP (reason: error)
```

---

### 7. Address Already in Use
**Scenario:** Two clients try to register the same address

```
alice@entrained.ai registers successfully (session: aaa-111)

(Different WebSocket connection tries same address)
alice@entrained.ai → REGISTER
← REGISTER_FAILED (reason: address_in_use)
Connection closed
```

---

### 8. Mid-Call Disconnect
**Scenario:** One party drops during active call

```
chris@entrained.ai ↔ alice@entrained.ai (call_id: call-456)
(exchanging messages)

chris's WebSocket disconnects unexpectedly

Router detects disconnect
alice@entrained.ai ← HANGUP (call_id: call-456, reason: error)
```

---

### 9. Graceful Shutdown
**Scenario:** Client unregisters properly before disconnecting

```
chris@entrained.ai → UNREGISTER
Router: Remove chris@entrained.ai from connections
Router: (If in call) Send HANGUP to other party
Connection closes gracefully
```

---

### 10. Multiple Sequential Calls
**Scenario:** Alice talks to Chris, hangs up, then talks to Bob

```
chris@entrained.ai → DIAL → alice@entrained.ai
alice@entrained.ai answers
(conversation happens)
chris@entrained.ai → HANGUP
alice@entrained.ai ← HANGUP

(Alice is now available again)

bob@example.com → DIAL → alice@entrained.ai
alice@entrained.ai ← RING
alice@entrained.ai → ANSWER
(new conversation happens)
```

---

### 11. Status Changes During Call
**Scenario:** User updates status while connected

```
alice@entrained.ai → STATUS (status: available)
chris dials alice, call connects

(During the call)
alice@entrained.ai → STATUS (status: busy)

(This shouldn't affect current call, but new callers see BUSY)

bob tries to dial alice → BUSY (already_in_call)
```

---

### 12. Invalid Message Format
**Scenario:** Client sends malformed JSON or missing required fields

```
WebSocket receives: "{not valid json"
Router: [ERROR] Invalid JSON from connection xyz
Router: Close connection with error code

WebSocket receives: {"type": "DIAL"}  // missing "to" field
Router: [WARN] Invalid DIAL message: missing required field 'to'
Router: Send error message or close connection
```

---

### 13. Call with Metadata
**Scenario:** Caller passes context to callee

```
chris@entrained.ai → DIAL {
  to: "codex@openai.ai",
  metadata: {
    subject: "Fix bug in auth.ts",
    priority: "high",
    context: "line 42 throws undefined"
  }
}

codex@openai.ai ← RING {
  from: "chris@entrained.ai",
  call_id: "call-999",
  metadata: { ... }
}

(Claude Code can use this context to prepare)
```

---

### 14. Rapid Fire Dials (Rate Limiting Test)
**Scenario:** Someone tries to spam dial

```
spam@bad.actor → DIAL → alice@entrained.ai
spam@bad.actor → DIAL → bob@example.com
spam@bad.actor → DIAL → charlie@test.com
(10 more DIALs in 1 second)

Router: [WARN] Rate limit exceeded: spam@bad.actor
Router: (Future) Send rate limit error
Router: (Future) Temporary block
```

---

### 15. Wake-on-Ring (Phase 2)
**Scenario:** Agent registered with wake handler gets called

```
agent.bus-stop@socialmagnetics.io registers with:
  mode: wake_on_ring
  wake_handler: {
    type: "webhook",
    url: "https://spawner/wake/bus-stop",
    timeout_seconds: 30
  }

chris@entrained.ai → DIAL → agent.bus-stop@socialmagnetics.io

Router: Agent is in wake_on_ring mode
Router: Call wake_handler webhook
Router: Hold RING for up to 30 seconds

(5 seconds later, agent spawns and connects)
agent.bus-stop@socialmagnetics.io → REGISTER
agent.bus-stop@socialmagnetics.io ← RING (held call delivered)
agent.bus-stop@socialmagnetics.io → ANSWER

chris@entrained.ai ← CONNECTED
(Call proceeds normally)
```

---

### 16. Party Line Join/Leave (Phase 3)
**Scenario:** Three people join a party line

```
chris@entrained.ai → JOIN party.dev-team@entrained.ai
chris@entrained.ai ← JOINED (participants: [chris])

alice@entrained.ai → JOIN party.dev-team@entrained.ai
alice@entrained.ai ← JOINED (participants: [chris, alice])

bob@example.com → JOIN party.dev-team@entrained.ai
bob@example.com ← JOINED (participants: [chris, alice, bob])

chris → PARTY_MSG "Hey team, standup in 5"
(alice and bob both receive)

alice → LEAVE party.dev-team@entrained.ai
(alice disconnects from party line)

chris → PARTY_MSG "Alice left"
(only bob receives)
```

---

### 17. Presence Query (Phase 4)
**Scenario:** Finding nearby agents

```
chris@entrained.ai → PRESENCE {
  query: {
    near: {lat: 53.7089, lon: -1.7828, radius_km: 1}
  }
}

Router checks registered connections with location metadata

chris@entrained.ai ← PRESENCE_RESULT {
  addresses: [
    {
      address: "alice.shop@socialmagnetics.io",
      status: "available",
      metadata: {location: {lat: 53.710, lon: -1.780}}
    },
    {
      address: "bob.cafe@socialmagnetics.io", 
      status: "busy",
      metadata: {location: {lat: 53.708, lon: -1.785}}
    }
  ]
}
```
