#!/usr/bin/env bun
// Generic Listener Agent - Listens to broadcasts

const role = process.env.AGENT_ROLE || "employee";
const address = process.env.AGENT_ADDRESS || `${role}@office.corp`;
const emoji = process.env.AGENT_EMOJI || "👤";

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let activeBroadcastId: string | null = null;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log(`${emoji} ${role} connected to SystemX`);
  send({
    type: "REGISTER",
    address: address,
    metadata: {
      role: role,
      listening: true
    }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log(`${emoji} ${role} registered! Listening for broadcasts...`);

      // Dial into CEO's broadcast channel after a moment
      setTimeout(() => {
        console.log(`${emoji} Joining CEO's broadcast...`);
        send({
          type: "DIAL",
          to: "ceo@office.corp",
          metadata: { intent: "listen_to_broadcast" }
        });
      }, 1000);
      break;

    case "CONNECTED":
      activeBroadcastId = msg.call_id;
      console.log(`${emoji} Connected to broadcast channel!`);
      break;

    case "MSG":
      const message = msg.data;
      console.log(`\n${emoji} 📢 CEO ANNOUNCEMENT: "${message}"\n`);

      // React to specific announcements
      if (message.includes("bonus")) {
        setTimeout(() => {
          if (activeBroadcastId) {
            const responses = [
              "🎉 Thank you! This is amazing!",
              "💪 This motivates me to work even harder!",
              "🙌 Best company ever!",
              "😊 So grateful to be part of this team!"
            ];
            const response = responses[Math.floor(Math.random() * responses.length)];

            send({
              type: "MSG",
              call_id: activeBroadcastId,
              data: response,
              content_type: "text"
            });
          }
        }, 1000 + Math.random() * 1000);
      }

      if (message.includes("adjourned")) {
        setTimeout(() => {
          console.log(`${emoji} Meeting over, back to work!`);
          setTimeout(() => process.exit(0), 2000);
        }, 1000);
      }
      break;

    case "HANGUP":
      console.log(`${emoji} Broadcast ended`);
      activeBroadcastId = null;
      setTimeout(() => process.exit(0), 1000);
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log(`👋 ${role} disconnected`);
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(`\n👋 ${role} logging off...`);
  if (activeBroadcastId) send({ type: "HANGUP", call_id: activeBroadcastId });
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
