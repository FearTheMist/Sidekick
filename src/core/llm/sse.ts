export interface SsePacket {
  event?: string;
  data: string;
}

export async function* readSse(
  response: Response
): AsyncGenerator<SsePacket, void, unknown> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf8");
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const splitIndex = buffer.indexOf("\n\n");
      if (splitIndex < 0) {
        break;
      }

      const packetText = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const packet = parsePacket(packetText);
      if (packet) {
        yield packet;
      }
    }
  }

  buffer += decoder.decode();
  const finalPacket = parsePacket(buffer);
  if (finalPacket) {
    yield finalPacket;
  }
}

function parsePacket(text: string): SsePacket | undefined {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");

  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  return { event, data: dataLines.join("\n") };
}
