const { LlmGateway } = require("../out/core/llm/gateway");

const encoder = new TextEncoder();

function makeResponse(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  );
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function main() {
  const providers = [
    {
      id: "chat",
      label: "OpenAI Chat",
      apiType: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "x",
      defaultModel: "gpt-test",
    },
    {
      id: "responses",
      label: "OpenAI Responses",
      apiType: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "x",
      defaultModel: "gpt-test",
    },
    {
      id: "anthropic",
      label: "Anthropic Messages",
      apiType: "anthropic-messages",
      baseUrl: "https://example.test/v1",
      apiKey: "x",
      defaultModel: "claude-test",
    },
    {
      id: "compatible",
      label: "Compatible",
      apiType: "openai-compatible",
      compatibleMode: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "x",
      defaultModel: "compat-model",
    },
  ];

  const fetchMock = async (url) => {
    const textUrl = String(url);

    if (textUrl.endsWith("/chat/completions")) {
      return makeResponse([
        'data: {"choices":[{"delta":{"content":"chat-delta"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }

    if (textUrl.endsWith("/responses")) {
      return makeResponse([
        'data: {"type":"response.output_text.delta","delta":"response-delta"}\n\n',
        "data: [DONE]\n\n",
      ]);
    }

    return makeResponse([
      'data: {"type":"content_block_delta","delta":{"text":"anthropic-delta"}}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const gateway = new LlmGateway(providers, fetchMock);

  const chatEvents = await collect(
    gateway.streamChat({
      profile: { providerId: "chat" },
      messages: [{ role: "user", content: "hello" }],
    })
  );

  const responseEvents = await collect(
    gateway.streamChat({
      profile: { providerId: "responses" },
      messages: [{ role: "user", content: "hello" }],
    })
  );

  const anthropicEvents = await collect(
    gateway.streamChat({
      profile: { providerId: "anthropic" },
      messages: [{ role: "user", content: "hello" }],
    })
  );

  const compatibleEvents = await collect(
    gateway.streamChat({
      profile: { providerId: "compatible" },
      messages: [{ role: "user", content: "hello" }],
    })
  );

  const pass =
    chatEvents.some((event) => event.type === "text" && event.delta === "chat-delta") &&
    responseEvents.some((event) => event.type === "text" && event.delta === "response-delta") &&
    anthropicEvents.some((event) => event.type === "text" && event.delta === "anthropic-delta") &&
    compatibleEvents.some((event) => event.type === "text" && event.delta === "response-delta");

  if (!pass) {
    console.error("Gateway acceptance failed", {
      chatEvents,
      responseEvents,
      anthropicEvents,
      compatibleEvents,
    });
    process.exit(1);
  }

  console.log("Gateway acceptance passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
