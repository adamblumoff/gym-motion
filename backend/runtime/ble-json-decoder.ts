const MAX_BUFFER_LENGTH = 64 * 1024

type JsonObjectDecoderOptions<TObject> = {
  label: string
  onObject: (value: TObject) => void
  onParseError?: (error: Error, candidate: string) => void
}

type JsonObjectDecoder = {
  push: (chunk: Buffer | string) => void
  reset: () => void
}

export function createJsonObjectDecoder<TObject = unknown>({
  label,
  onObject,
  onParseError,
}: JsonObjectDecoderOptions<TObject>): JsonObjectDecoder {
  let buffer = ""
  let framedBuffer: string | null = null

  function emitParseError(error: unknown, candidate: string) {
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
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)

      if (value.startsWith("BEGIN:")) {
        framedBuffer = ""
        return
      }

      if (framedBuffer !== null) {
        if (value === "END") {
          const candidate = framedBuffer
          framedBuffer = null

          try {
            onObject(JSON.parse(candidate) as TObject)
          } catch (error) {
            emitParseError(error, candidate)
          }

          return
        }

        framedBuffer += value

        if (framedBuffer.length > MAX_BUFFER_LENGTH) {
          emitParseError(
            new Error(`${label} framed buffer overflow while waiting for END.`),
            framedBuffer.slice(0, 200),
          )
          framedBuffer = null
        }

        return
      }

      buffer += value

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
          onObject(JSON.parse(candidate) as TObject)
        } catch (error) {
          emitParseError(error, candidate)
        }
      }
    },

    reset() {
      buffer = ""
      framedBuffer = null
    },
  }
}
