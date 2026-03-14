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
})
