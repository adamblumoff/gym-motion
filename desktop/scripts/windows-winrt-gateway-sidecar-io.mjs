/* global Buffer, console */

export function attachJsonLineReader(stream, onEvent) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += Buffer.from(chunk).toString("utf8");

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        onEvent(JSON.parse(line));
      } catch (error) {
        console.error("[gateway-winrt] failed to parse sidecar output", line, error);
      }
    }
  });
}
