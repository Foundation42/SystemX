#!/usr/bin/env bun
// Dev Agent - Fixing bugs and fielding calls

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let activeCallId: string | null = null;
let coffeeOrdered = false;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log("💻 Dev connected to SystemX");
  send({
    type: "REGISTER",
    address: "dev@office.corp",
    metadata: { role: "developer", status: "coding", coffee_level: "low" }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("💻 Dev registered! Time to fix bugs...");

      // Order coffee after a bit
      setTimeout(() => {
        if (!coffeeOrdered) {
          console.log("☕ Coffee level critical! Calling coffee bot...");
          coffeeOrdered = true;
          send({
            type: "DIAL",
            to: "coffee@office.corp",
            metadata: { urgency: "critical", order: "double espresso" }
          });
        }
      }, 3000);
      break;

    case "RING":
      console.log(`📞 Incoming call from ${msg.from}!`);
      activeCallId = msg.call_id;

      if (msg.from === "boss@office.corp") {
        console.log("😰 It's the boss!");
      }

      send({ type: "ANSWER", call_id: activeCallId });
      break;

    case "CONNECTED":
      console.log(`🎉 Connected to ${msg.to}`);
      if (msg.to === "coffee@office.corp") {
        activeCallId = msg.call_id;
        setTimeout(() => {
          send({
            type: "MSG",
            call_id: msg.call_id,
            data: "One double espresso please! I'm debugging a race condition!",
            content_type: "text"
          });
        }, 500);
      }
      break;

    case "MSG":
      const question = msg.data;
      console.log(`💬 Received: "${question}"`);

      let response = "";
      if (question.toLowerCase().includes("bug")) {
        response = "Making great progress! Should be fixed by end of day. Just need more coffee...";
      } else if (question.toLowerCase().includes("espresso") || question.toLowerCase().includes("coffee")) {
        response = "Perfect! Thanks! This will help me squash these bugs!";
        setTimeout(() => {
          if (activeCallId) {
            send({ type: "HANGUP", call_id: activeCallId });
            console.log("📴 Dev hung up (back to coding!)");
          }
        }, 2000);
      } else {
        response = "All good here! Just coding away!";
      }

      setTimeout(() => {
        if (activeCallId) {
          send({
            type: "MSG",
            call_id: activeCallId,
            data: response,
            content_type: "text"
          });
        }
      }, 500);
      break;

    case "HANGUP":
      console.log(`📴 Call ended`);
      activeCallId = null;
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 Dev disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Dev logging off...");
  if (activeCallId) send({ type: "HANGUP", call_id: activeCallId });
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
