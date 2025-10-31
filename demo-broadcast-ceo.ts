#!/usr/bin/env bun
// CEO Agent - Broadcasting all-hands meeting!

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let meetingCallId: string | null = null;
let responses = 0;
const expectedResponses = 3; // Dev, Designer, Coffee Bot

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log("👔 CEO connected to SystemX");
  send({
    type: "REGISTER",
    address: "ceo@office.corp",
    concurrency: "broadcast",  // 🎯 BROADCAST MODE!
    metadata: {
      role: "ceo",
      title: "Chief Executive Officer",
      power_level: "over_9000"
    }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("👔 CEO registered with BROADCAST MODE!");
      console.log("📢 Starting All-Hands Meeting in 2 seconds...");

      // Give other agents time to register
      setTimeout(() => {
        console.log("\n🎤 CEO: Beginning All-Hands Meeting!");
        console.log("📢 Broadcasting to the entire company...\n");

        // Broadcast announcement
        send({
          type: "MSG",
          data: "🎤 ATTENTION EVERYONE! All-hands meeting starting NOW! Great news to share about our Q4 results!",
          content_type: "text"
        });

        setTimeout(() => {
          send({
            type: "MSG",
            data: "💰 We exceeded our revenue targets by 150%! Amazing work team!",
            content_type: "text"
          });
        }, 2000);

        setTimeout(() => {
          send({
            type: "MSG",
            data: "🎉 Everyone gets a bonus! Also, free coffee for life! Coffee Bot, you're getting a raise!",
            content_type: "text"
          });
        }, 4000);

        setTimeout(() => {
          send({
            type: "MSG",
            data: "✨ Keep up the great work! Meeting adjourned. Back to building awesome things!",
            content_type: "text"
          });
        }, 6000);

        // End broadcast after announcements
        setTimeout(() => {
          console.log("\n👔 CEO: All-hands meeting complete!");
          setTimeout(() => process.exit(0), 2000);
        }, 8000);
      }, 2000);
      break;

    case "MSG":
      responses++;
      console.log(`💬 Response from ${msg.from}: "${msg.data}"`);

      if (responses >= expectedResponses) {
        console.log("\n✅ Everyone acknowledged the announcements!");
      }
      break;

    case "RING":
      // Someone's trying to call us during broadcast
      console.log(`📞 Incoming call from ${msg.from} (during broadcast!)`);
      meetingCallId = msg.call_id;
      send({ type: "ANSWER", call_id: meetingCallId });
      break;

    case "CONNECTED":
      console.log(`🎉 ${msg.from || msg.to} joined the broadcast!`);
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 CEO disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 CEO logging off...");
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
