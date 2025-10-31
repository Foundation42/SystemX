#!/usr/bin/env bun
// Talking Clock - Classic broadcast example
// Everyone who calls gets the same time announcements

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let broadcastCallId: string | null = null;
let listenerCount = 0;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

function getCurrentTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

ws.addEventListener("open", () => {
  console.log("🕐 Talking Clock connected to SystemX");
  send({
    type: "REGISTER",
    address: "talking-clock@time-services.io",
    concurrency: "broadcast",  // 🎯 Multiple listeners, shared session!
    max_listeners: 1000,
    metadata: {
      service: "time_announcements",
      timezone: "local"
    }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("🕐 Talking Clock registered in BROADCAST mode!");
      console.log("📢 Waiting for listeners to call in...\n");

      // Start announcing time every 3 seconds once we have the broadcast channel
      const announceInterval = setInterval(() => {
        if (broadcastCallId && listenerCount > 0) {
          const time = getCurrentTime();
          console.log(`\n🕐 Broadcasting time to ${listenerCount} listener(s): ${time}`);
          send({
            type: "MSG",
            call_id: broadcastCallId,
            data: `🕐 The time is now ${time}`,
            content_type: "text"
          });
        }
      }, 3000);

      // Cleanup interval on exit
      process.on('beforeExit', () => clearInterval(announceInterval));
      break;

    case "RING":
      listenerCount++;
      console.log(`📞 New listener calling in! (${msg.from})`);
      console.log(`👥 Total listeners: ${listenerCount}`);

      // Answer and remember the call_id - ALL listeners share this!
      broadcastCallId = msg.call_id;
      send({ type: "ANSWER", call_id: broadcastCallId });

      // Welcome message to the broadcast
      setTimeout(() => {
        if (broadcastCallId) {
          send({
            type: "MSG",
            call_id: broadcastCallId,
            data: `📢 Welcome ${msg.from}! You are now listening to the Talking Clock. Time announcements every 3 seconds.`,
            content_type: "text"
          });
        }
      }, 500);
      break;

    case "HANGUP":
      listenerCount = Math.max(0, listenerCount - 1);
      console.log(`📴 A listener hung up`);
      console.log(`👥 Remaining listeners: ${listenerCount}`);

      if (listenerCount === 0) {
        console.log("🔇 No more listeners. Waiting for new callers...\n");
        broadcastCallId = null;
      }
      break;

    case "MSG":
      // Listeners can send messages back (party-line style!)
      console.log(`💬 Message from ${msg.from}: "${msg.data}"`);
      if (broadcastCallId) {
        send({
          type: "MSG",
          call_id: broadcastCallId,
          data: `📢 ${msg.from} says: "${msg.data}"`,
          content_type: "text"
        });
      }
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 Talking Clock disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Talking Clock shutting down...");
  if (broadcastCallId) send({ type: "HANGUP", call_id: broadcastCallId });
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
