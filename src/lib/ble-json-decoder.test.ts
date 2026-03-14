import { describe, expect, it } from "bun:test"

import { createJsonObjectDecoder } from "../../scripts/ble-json-decoder.mjs"

describe("createJsonObjectDecoder", () => {
  it("reassembles a JSON object split across BLE notifications", () => {
    const payloads = []
    const decoder = createJsonObjectDecoder({
      label: "telemetry:test",
      onObject: (payload) => {
        payloads.push(payload)
      },
    })

    decoder.push('{"deviceId":"stack-001","state":"mov')
    decoder.push('ing","delta":12,"timestamp":42}')

    expect(payloads).toEqual([
      {
        deviceId: "stack-001",
        state: "moving",
        delta: 12,
        timestamp: 42,
      },
    ])
  })

  it("extracts back-to-back JSON objects from one notification chunk", () => {
    const payloads = []
    const decoder = createJsonObjectDecoder({
      label: "status:test",
      onObject: (payload) => {
        payloads.push(payload)
      },
    })

    decoder.push('{"type":"ota-status","phase":"ready"}{"type":"ota-status","phase":"applied"}')

    expect(payloads).toEqual([
      {
        type: "ota-status",
        phase: "ready",
      },
      {
        type: "ota-status",
        phase: "applied",
      },
    ])
  })

  it("decodes a framed JSON message carried over multiple chunks", () => {
    const payloads = []
    const decoder = createJsonObjectDecoder({
      label: "history:test",
      onObject: (payload) => {
        payloads.push(payload)
      },
    })

    decoder.push("BEGIN:42")
    decoder.push('{"type":"history-sync-complete","sentCount":2')
    decoder.push(',"hasMore":false}')
    decoder.push("END")

    expect(payloads).toEqual([
      {
        type: "history-sync-complete",
        sentCount: 2,
        hasMore: false,
      },
    ])
  })
})
