import { createServer } from "node:http";

// Loopback-only Responses provider: deterministic output, no account, LLM or external network.
export async function startImageProvider() {
  const inputs = [];
  const instructions = [];
  const traffic = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    inputs.push(body.input);
    instructions.push(body.instructions);
    traffic.push({ bytes: size, reasoning: body.reasoning, text: body.text });
    const text = "Imagem sintética recebida pelo provedor local.";
    const item = {
      id: "msg_stag_image",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const result = {
      id: "resp_stag_image",
      object: "response",
      created_at: 1,
      model: body.model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const events = [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ];
    events.forEach((event, index) =>
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
      ),
    );
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    inputs,
    instructions,
    traffic,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
