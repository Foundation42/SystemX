#!/usr/bin/env bun
// Designer Agent - Working on mockups

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let activeCallId: string | null = null;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log("🎨 Designer connected to SystemX");
  send({
    type: "REGISTER",
    address: "designer@office.corp",
    metadata: { role: "designer", status: "designing", tool: "figma" }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("🎨 Designer registered! Creating beautiful mockups...");
      break;

    case "RING":
      console.log(`📞 Incoming call from ${msg.from}!`);
      activeCallId = msg.call_id;

      if (msg.from === "boss@office.corp") {
        console.log("🎨 Boss calling! Better have good news...");
      }

      send({ type: "ANSWER", call_id: activeCallId });
      break;

    case "MSG":
      const question = msg.data;
      console.log(`💬 Received: "${question}"`);

      let response = "";
      if (question.toLowerCase().includes("mockup")) {
        response = "Yes! Just finished the new design system. Want me to share the Figma link?";
      } else if (question.toLowerCase().includes("good") || question.toLowerCase().includes("keep")) {
        response = "Will do! Finishing up the mobile views now!";
        setTimeout(() => {
          if (activeCallId) {
            send({ type: "HANGUP", call_id: activeCallId });
            console.log("📴 Designer hung up (back to Figma!)");
          }
        }, 1500);
      } else {
        response = "Everything's looking great! The color palette is *chef's kiss*";
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
      }, 700);
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
  console.log("👋 Designer disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Designer logging off...");
  if (activeCallId) send({ type: "HANGUP", call_id: activeCallId });
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
