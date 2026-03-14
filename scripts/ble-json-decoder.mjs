const MAX_BUFFER_LENGTH = 64 * 1024

export function createJsonObjectDecoder({ label, onObject, onParseError }) {
  let buffer = ""

  function emitParseError(error, candidate) {
    onParseError?.(
      error instanceof Error ? error : new Error(String(error)),
      candidate,
    )
  }

  function trimLeadingNoise() {
    const objectStart = buffer.indexOf("{")

    if (objectStart === -1) {
      if (buffer.length > MAX_BUFFER_LENGTH) {
        emitParseError(
          new Error(`${label} buffer overflow without JSON object start.`),
          buffer.slice(0, 200),
        )
        buffer = ""
      }
      return false
    }

    if (objectStart > 0) {
      buffer = buffer.slice(objectStart)
    }

    return true
  }

  function findCompleteObjectEnd() {
    let depth = 0
    let inString = false
    let escaped = false

    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index]

      if (escaped) {
        escaped = false
        continue
      }

      if (character === "\\") {
        escaped = true
        continue
      }

      if (character === "\"") {
        inString = !inString
        continue
      }

      if (inString) {
        continue
      }

      if (character === "{") {
        depth += 1
        continue
      }

      if (character === "}") {
        depth -= 1

        if (depth === 0) {
          return index
        }
      }
    }

    return -1
  }

  return {
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)

      while (trimLeadingNoise()) {
        const objectEnd = findCompleteObjectEnd()

        if (objectEnd === -1) {
          if (buffer.length > MAX_BUFFER_LENGTH) {
            emitParseError(
              new Error(`${label} buffer overflow while waiting for JSON end.`),
              buffer.slice(0, 200),
            )
            buffer = ""
          }
          return
        }

        const candidate = buffer.slice(0, objectEnd + 1)
        buffer = buffer.slice(objectEnd + 1)

        try {
          onObject(JSON.parse(candidate))
        } catch (error) {
          emitParseError(error, candidate)
        }
      }
    },

    reset() {
      buffer = ""
    },
  }
}
