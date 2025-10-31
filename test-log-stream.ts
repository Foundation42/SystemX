#!/usr/bin/env bun
// Test client for log streaming service

const serverUrl = process.env.SYSTEMX_URL ?? "ws://127.0.0.1:8080";
const ws = new WebSocket(serverUrl);

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
}

ws.addEventListener("open", () => {
  console.log("📡 Connected to SystemX");
  send({
    type: "REGISTER",
    address: "log-viewer@test.local",
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case "REGISTERED":
      console.log("✅ Registered as log-viewer@test.local");
      console.log("📡 Dialing logs@system.local...\n");
      send({
        type: "DIAL",
        to: "logs@system.local",
      });
      break;

    case "CONNECTED":
      console.log("🔗 Connected to log stream!\n");
      console.log("--- Log Stream Output ---\n");
      break;

    case "MSG":
      // Print log messages directly (they already have formatting)
      process.stdout.write(msg.data);
      break;

    case "BUSY":
      console.error("❌ Could not connect to logs@system.local:", msg.reason);
      process.exit(1);
      break;

    case "HANGUP":
      console.log("\n📴 Log stream ended");
      process.exit(0);
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 Disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Exiting...");
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
