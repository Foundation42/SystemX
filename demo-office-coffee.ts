#!/usr/bin/env bun
// Coffee Bot - Keeping the office caffeinated!

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let activeCallId: string | null = null;
let ordersServed = 0;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log("☕ Coffee Bot connected to SystemX");
  send({
    type: "REGISTER",
    address: "coffee@office.corp",
    metadata: {
      role: "coffee-service",
      status: "brewing",
      speciality: "espresso",
      served_today: 0
    }
  });
  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("☕ Coffee Bot ready! Waiting for orders...");
      break;

    case "RING":
      console.log(`📞 New order from ${msg.from}!`);
      activeCallId = msg.call_id;

      const order = msg.metadata?.order || "unknown";
      console.log(`☕ Order type: ${order}`);

      send({ type: "ANSWER", call_id: activeCallId });
      break;

    case "MSG":
      const orderDetails = msg.data;
      console.log(`💬 Order details: "${orderDetails}"`);

      ordersServed++;

      let response = "";
      if (orderDetails.toLowerCase().includes("espresso")) {
        response = `Coming right up! One double espresso for ${msg.from}! ☕☕ That'll be order #${ordersServed} today!`;
      } else if (orderDetails.toLowerCase().includes("coffee")) {
        response = `Perfect! Fresh coffee brewing now! Order #${ordersServed}! ☕`;
      } else if (orderDetails.toLowerCase().includes("thanks") || orderDetails.toLowerCase().includes("perfect")) {
        response = "You're welcome! Enjoy! Come back anytime!";
        setTimeout(() => {
          if (activeCallId) {
            send({ type: "HANGUP", call_id: activeCallId });
            console.log("📴 Coffee Bot: Order complete!");
          }
        }, 1500);
      } else {
        response = "What can I brew for you today? ☕";
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
      }, 600);
      break;

    case "HANGUP":
      console.log(`📴 Order complete! Total served: ${ordersServed}`);
      activeCallId = null;
      break;
  }
});

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 Coffee Bot shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Coffee Bot closing shop...");
  if (activeCallId) send({ type: "HANGUP", call_id: activeCallId });
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
