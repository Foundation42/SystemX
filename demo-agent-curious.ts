#!/usr/bin/env bun
// Curious Agent - Calls helper and asks questions

const serverUrl = process.env.SYSTEMX_URL ?? "wss://engram-fi-1.entrained.ai:2096";
const ws = new WebSocket(serverUrl);

let activeCallId: string | null = null;
const questions = [
  "Hello! Can you hear me?",
  "What's the weather like?",
  "Tell me about SystemX!",
  "Thanks for the chat! Bye!"
];
let currentQuestion = 0;

function send(payload: Record<string, unknown>) {
  ws.send(JSON.stringify(payload));
  console.log("→", payload);
}

ws.addEventListener("open", () => {
  console.log(`🤔 Curious Agent connected to ${serverUrl}`);
  send({
    type: "REGISTER",
    address: "curious@user.com",
    metadata: {
      client: "demo-curious-agent"
    }
  });

  setInterval(() => send({ type: "HEARTBEAT" }), 15_000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", msg);

  switch (msg.type) {
    case "REGISTERED":
      console.log("✅ Curious agent registered!");
      console.log("📞 Calling helper@ai.bot...");
      send({
        type: "DIAL",
        to: "helper@ai.bot",
        metadata: { subject: "Just curious!" }
      });
      break;

    case "CONNECTED":
      console.log("🎉 Call connected!");
      activeCallId = msg.call_id;

      // Ask first question
      setTimeout(() => askNextQuestion(), 1000);
      break;

    case "MSG":
      const answer = msg.data;
      console.log(`💬 Helper says: "${answer}"`);

      // Ask next question after a delay
      setTimeout(() => askNextQuestion(), 2000);
      break;

    case "BUSY":
      console.log(`❌ Helper is busy: ${msg.reason}`);
      setTimeout(() => process.exit(1), 500);
      break;

    case "HANGUP":
      console.log(`📴 Call ended (${msg.reason || "normal"})`);
      activeCallId = null;
      console.log("✅ Conversation complete!");
      setTimeout(() => process.exit(0), 500);
      break;
  }
});

function askNextQuestion() {
  if (currentQuestion >= questions.length) {
    console.log("✅ All questions asked!");
    return;
  }

  const question = questions[currentQuestion++];
  console.log(`❓ Asking: "${question}"`);

  if (activeCallId) {
    send({
      type: "MSG",
      call_id: activeCallId,
      data: question,
      content_type: "text"
    });
  }
}

ws.addEventListener("error", (error) => {
  console.error("❌ Error:", error.message);
});

ws.addEventListener("close", () => {
  console.log("👋 Disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down curious agent...");
  if (activeCallId) {
    send({ type: "HANGUP", call_id: activeCallId });
  }
  send({ type: "UNREGISTER" });
  setTimeout(() => process.exit(0), 500);
});
