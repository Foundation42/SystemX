#!/usr/bin/env bun
// Helper Agent - Waits for calls and responds helpfully

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let activeCallId: string | null = null;
let conversationTurns = 0;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log(`🤖 Helper Agent connected to ${serverUrl}`);
  send({
    type: "REGISTER",
    address: "helper@ai.bot",
    metadata: {
      capabilities: ["chat", "help", "questions"],
      status: "available"
    }
  });

  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("✅ Helper agent registered! Waiting for calls...");
      break;

    case "RING":
      console.log(`📞 Incoming call from ${msg.from}`);
      activeCallId = msg.call_id;
      send({ type: "ANSWER", call_id: activeCallId });
      break;

    case "MSG":
      conversationTurns++;
      const question = msg.data;
      console.log(`💬 Question: "${question}"`);

      // Generate a response based on the question
      let response = "";
      if (question.toLowerCase().includes("hello") || question.toLowerCase().includes("hi")) {
        response = "Hello! I'm a helper agent running on SystemX. How can I assist you today?";
      } else if (question.toLowerCase().includes("weather")) {
        response = "The weather is beautiful in the digital realm - sunny with a chance of packets! ☀️";
      } else if (question.toLowerCase().includes("systemx")) {
        response = "SystemX is amazing! It's like a telephone exchange for agents. We're talking through it right now!";
      } else if (question.toLowerCase().includes("thank") || question.toLowerCase().includes("bye")) {
        response = "You're welcome! It was great chatting. Have a wonderful day!";
        setTimeout(() => {
          if (activeCallId) {
            send({ type: "HANGUP", call_id: activeCallId });
            console.log("👋 Hanging up...");
          }
        }, 1000);
      } else {
        response = `Interesting question! I've answered ${conversationTurns} questions so far. Keep them coming!`;
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
      console.log(`📴 Call ended (${msg.reason || "normal"})`);
      activeCallId = null;
      conversationTurns = 0;
      console.log("✅ Ready for next call...");
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
  console.log("\n👋 Shutting down helper agent...");
  if (activeCallId) {
    send({ type: "HANGUP", call_id: activeCallId });
  }
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
