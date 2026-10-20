import { describe, it, expect, afterEach } from 'bun:test'
import { useGodotBridge } from './useGodotBridge'

describe('useGodotBridge fetch-only operation', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetchGeoJsonFromGodot calls /api/fetch and returns GeoJSON payload without generating scene', async () => {
    const sampleGeoJson = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        bbox: [-71.11, 42.41, -71.1, 42.42],
        counts: { segment: 10, building: 5 },
        total_features: 15
      },
      features: [
        {
          type: 'Feature',
          properties: { overture_type: 'segment' },
          geometry: { type: 'LineString', coordinates: [[-71.11, 42.41], [-71.1, 42.42]] }
        }
      ]
    }

    let calledUrl = ''
    let calledMethod = ''
    let calledBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url
      calledMethod = init?.method || 'GET'
      calledBody = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null
      return {
        ok: true,
        json: async () => ({
          success: true,
          saved_path: 'res://data/overture_export.geojson',
          format: 'geojson',
          geojson: sampleGeoJson,
          stats: { roads: 1, buildings: 0, elements: 1 }
        })
      } as Response
    }) as unknown as typeof fetch

    const { fetchGeoJsonFromGodot, isConnected, lastTransferError } = useGodotBridge()
    const queryBox = { west: -71.11, south: 42.41, east: -71.1, north: 42.42 }
    const result = await fetchGeoJsonFromGodot(queryBox)

    expect(calledUrl).toContain('/api/fetch')
    expect(calledMethod).toBe('POST')
    expect(calledBody).toEqual({
      bbox: [-71.11, 42.41, -71.1, 42.42],
      source: 'overture'
    })
    expect(result).toBeDefined()
    expect(result?.type).toBe('FeatureCollection')
    expect(Array.isArray(result?.features) ? result.features.length : 0).toBe(1)
    expect(isConnected.value).toBe(true)
    expect(lastTransferError.value).toBeNull()
  })

  it('fetchGeoJsonFromGodot surfaces error message when server responds with failure', async () => {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          success: false,
          error: 'Overture fetch script failed: timeout'
        })
      } as Response
    }) as unknown as typeof fetch

    const { fetchGeoJsonFromGodot, lastTransferError } = useGodotBridge()
    const result = await fetchGeoJsonFromGodot({ west: 0, south: 0, east: 1, north: 1 })

    expect(result).toBeNull()
    expect(lastTransferError.value).toBe('Overture fetch script failed: timeout')
  })

  it('fetchGeoJsonFromGodot surfaces network error when server cannot be reached', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Connection refused')
    }) as unknown as typeof fetch

    const { fetchGeoJsonFromGodot, lastTransferError } = useGodotBridge()
    const result = await fetchGeoJsonFromGodot({ west: 0, south: 0, east: 1, north: 1 })

    expect(result).toBeNull()
    expect(lastTransferError.value).toContain('Connection refused')
  })
})
describe('useGodotBridge editor payload versions and import handler contract', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const validPayload = {
    type: 'FeatureCollection',
    generator: 'osm-to-godot-editor',
    editorPayloadVersion: '1.0.0',
    metadata: {
      generator: 'osm-to-godot-editor',
      version: '1.0.0',
      projectionOrigin: { lon: -71.11, lat: 42.415 }
    },
    projectionOrigin: { lon: -71.11, lat: 42.415 },
    features: [
      {
        type: 'Feature',
        id: 'surface/road/1',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.11, 42.415],
              [-71.109, 42.415],
              [-71.109, 42.416],
              [-71.11, 42.416],
              [-71.11, 42.415]
            ]
          ]
        },
        properties: {
          role: 'carriageway',
          kind: 'road',
          isFootprintAuthority: true
        }
      }
    ]
  }

  it('checkConnection receives supported_editor_payload_versions from Godot server', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/status')) {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            app: 'osm-to-godot',
            port: 8080,
            version: '1.0.0',
            supported_editor_payload_versions: ['1.0.0']
          })
        } as Response
      }
      return { ok: false } as Response
    }) as unknown as typeof fetch

    const { checkConnection, isConnected, supportedServerVersions } = useGodotBridge()
    const connected = await checkConnection()
    expect(connected).toBe(true)
    expect(isConnected.value).toBe(true)
    expect(supportedServerVersions.value).toEqual(['1.0.0'])
  })

  it('isEditorPayload correctly distinguishes editor payloads from raw data', () => {
    const { isEditorPayload } = useGodotBridge()
    expect(isEditorPayload(validPayload)).toBe(true)
    expect(isEditorPayload({ type: 'FeatureCollection', features: [] })).toBe(false)
    expect(isEditorPayload({ elements: [] })).toBe(false)
    expect(isEditorPayload({ metadata: { generator: 'osm-to-godot-editor' } })).toBe(true)
  })

  it('sendToGodot sends valid 1.0.0 editor payload and populates stats', async () => {
    let sentBody: Record<string, unknown> | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({
          success: true,
          saved_path: 'res://data/editor_export.geojson',
          format: 'editor',
          stats: { roads: 1, buildings: 0, elements: 1 }
        })
      } as Response
    }) as unknown as typeof fetch

    const { sendToGodot, lastTransferStats, lastTransferError } = useGodotBridge()
    const success = await sendToGodot(validPayload)

    expect(success).toBe(true)
    expect(sentBody?.editorPayloadVersion).toBe('1.0.0')
    expect(lastTransferError.value).toBeNull()
    expect(lastTransferStats.value).toEqual({
      roads: 1,
      buildings: 0,
      elements: 1,
      savedPath: 'res://data/editor_export.geojson'
    })
  })

  it('sendToGodot clearly rejects unsupported editor payload versions', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const unsupportedPayload = {
      ...validPayload,
      editorPayloadVersion: '2.0.0'
    }

    const { sendToGodot, lastTransferError } = useGodotBridge()
    const success = await sendToGodot(unsupportedPayload)

    expect(success).toBe(false)
    expect(fetchCalled).toBe(false) // rejected before sending
    expect(lastTransferError.value).toContain('Unsupported editor payload version: "2.0.0"')
    expect(lastTransferError.value).toContain('Supported versions: 1.0.0')
  })

  it('sendToGodot clearly rejects missing editor payload version', async () => {
    const missingVersionPayload = {
      ...validPayload,
      editorPayloadVersion: undefined
    }

    const { sendToGodot, lastTransferError } = useGodotBridge()
    const success = await sendToGodot(missingVersionPayload)

    expect(success).toBe(false)
    expect(lastTransferError.value).toContain('Missing editor payload version')
    expect(lastTransferError.value).toContain('Supported versions: 1.0.0')
  })

  it('sendToGodot surfaces Godot HTTP server version rejection error when skipping client validation', async () => {
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          success: false,
          error: 'Unsupported editor payload version: "9.9.9". Supported versions: 1.0.0.'
        })
      } as Response
    }) as unknown as typeof fetch

    const { sendToGodot, lastTransferError } = useGodotBridge()
    const success = await sendToGodot(
      { ...validPayload, editorPayloadVersion: '9.9.9' },
      { skipValidation: true }
    )

    expect(success).toBe(false)
    expect(lastTransferError.value).toContain('Unsupported editor payload version: "9.9.9"')
    expect(lastTransferError.value).toContain('Supported versions: 1.0.0')
  })

  it('checkConnection correctly reports disconnected when Godot status endpoint fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Connection refused')
    }) as unknown as typeof fetch

    const { checkConnection, isConnected } = useGodotBridge()
    const connected = await checkConnection()

    expect(connected).toBe(false)
    expect(isConnected.value).toBe(false)
  })
})
