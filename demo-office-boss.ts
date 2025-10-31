#!/usr/bin/env bun
// Boss Agent - Needs those status updates!

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let devCallId: string | null = null;
let designerCallId: string | null = null;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log("🎩 Boss connected to SystemX");
  send({
    type: "REGISTER",
    address: "boss@office.corp",
    metadata: { role: "management", mood: "demanding" }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("🎩 Boss registered! Time to check on everyone...");

      // Call the dev first
      setTimeout(() => {
        console.log("📞 Calling dev for status update...");
        send({
          type: "DIAL",
          to: "dev@office.corp",
          metadata: { priority: "high", subject: "Status Update Needed" }
        });
      }, 1000);

      // Then call the designer
      setTimeout(() => {
        console.log("📞 Calling designer about mockups...");
        send({
          type: "DIAL",
          to: "designer@office.corp",
          metadata: { priority: "medium", subject: "Mockup Review" }
        });
      }, 2000);
      break;

    case "CONNECTED":
      if (msg.to === "dev@office.corp") {
        devCallId = msg.call_id;
        console.log("🎩 Dev picked up! Asking about bugs...");
        setTimeout(() => {
          if (devCallId) {
            send({
              type: "MSG",
              call_id: devCallId,
              data: "How's that critical bug fix coming along?",
              content_type: "text"
            });
          }
        }, 500);
      } else if (msg.to === "designer@office.corp") {
        designerCallId = msg.call_id;
        console.log("🎩 Designer picked up! Asking about mockups...");
        setTimeout(() => {
          if (designerCallId) {
            send({
              type: "MSG",
              call_id: designerCallId,
              data: "Do we have those new mockups ready?",
              content_type: "text"
            });
          }
        }, 500);
      }
      break;

    case "MSG":
      console.log(`💬 Response: "${msg.data}"`);

      // Boss responds and hangs up after getting answer
      setTimeout(() => {
        send({
          type: "MSG",
          call_id: msg.call_id,
          data: "Good! Keep me posted!",
          content_type: "text"
        });

        setTimeout(() => {
          send({ type: "HANGUP", call_id: msg.call_id });
          console.log("📴 Boss hung up (busy boss!)");
        }, 1000);
      }, 1000);
      break;

    case "BUSY":
      console.log(`❌ ${msg.reason}`);
      break;

    case "HANGUP":
      console.log(`📴 Call ended with ${msg.call_id}`);
      if (msg.call_id === devCallId) devCallId = null;
      if (msg.call_id === designerCallId) designerCallId = null;

      // Exit after both calls are done
      if (!devCallId && !designerCallId) {
        console.log("✅ All status updates collected!");
        setTimeout(() => process.exit(0), 2000);
      }
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 Boss disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Boss logging off...");
  if (devCallId) send({ type: "HANGUP", call_id: devCallId });
  if (designerCallId) send({ type: "HANGUP", call_id: designerCallId });
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
