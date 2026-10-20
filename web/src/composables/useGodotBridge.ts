import { ref } from 'vue'
import type { OSMExportPayload } from '@/services/overpass'
import {
  CURRENT_EDITOR_PAYLOAD_VERSION,
  SUPPORTED_EDITOR_PAYLOAD_VERSIONS
} from '@/composables/editor/types'
import { validateEditorGodotPayload } from '@/composables/editor/validation'

export interface GodotBridgeOptions {
  skipValidation?: boolean
}

export interface GodotImportStats {
  roads: number
  buildings: number
  elements: number
  savedPath?: string
}

const isConnected = ref(false)
const isChecking = ref(false)
const isSending = ref(false)
const godotPort = ref(8080)
const lastTransferStats = ref<GodotImportStats | null>(null)
const lastTransferError = ref<string | null>(null)
const supportedServerVersions = ref<string[]>([...SUPPORTED_EDITOR_PAYLOAD_VERSIONS])


// Default URL: if on Vite dev server (5173), target 127.0.0.1:8080.
// Otherwise target current origin (when served directly by Godot plugin).
const defaultGodotUrl = typeof window !== 'undefined' && window.location.port !== '5173'
  ? window.location.origin
  : 'http://127.0.0.1:8080'

const godotUrl = ref(defaultGodotUrl)
let heartbeatTimer: NodeJS.Timeout | number | null = null
export function useGodotBridge() {
  async function checkConnection(): Promise<boolean> {
    isChecking.value = true
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 1500)

      const res = await fetch(`${godotUrl.value}/api/status`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      })
      clearTimeout(timeoutId)

      if (res.ok) {
        const data = await res.json()
        if (data.app === 'osm-to-godot' || data.status === 'ok') {
          isConnected.value = true
          if (data.port) godotPort.value = data.port
          if (Array.isArray(data.supported_editor_payload_versions)) {
            supportedServerVersions.value = data.supported_editor_payload_versions
          }
          lastTransferError.value = null
          return true
        }
      }
      isConnected.value = false
      return false
    } catch {
      isConnected.value = false
      return false
    } finally {
      isChecking.value = false
    }
  }

  function isEditorPayload(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false
    const raw = payload as Record<string, unknown>
    const meta = (raw.metadata || {}) as Record<string, unknown>
    return Boolean(
      raw.editorPayloadVersion ||
      raw.editor_payload_version ||
      meta.editorPayloadVersion ||
      meta.editor_payload_version ||
      String(raw.generator || '').startsWith('osm-to-godot-editor') ||
      String(meta.generator || '').startsWith('osm-to-godot-editor')
    )
  }


  async function sendToGodot(
    payload: OSMExportPayload | Record<string, unknown>,
    options?: GodotBridgeOptions
  ): Promise<boolean> {
    isSending.value = true
    lastTransferError.value = null

    try {
      if (isEditorPayload(payload) && !options?.skipValidation) {
        const validation = validateEditorGodotPayload(payload)
        if (!validation.valid) {
          const firstErr = validation.errors[0] || 'Invalid editor payload'
          throw new Error(firstErr)
        }
        if (validation.version && !supportedServerVersions.value.includes(validation.version)) {
          throw new Error(
            `Unsupported editor payload version: "${validation.version}". Supported versions: ${supportedServerVersions.value.join(', ')}.`
          )
        }
      }

      const res = await fetch(`${godotUrl.value}/api/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        let errorDetails = ''
        try {
          const errJson = await res.json()
          errorDetails = errJson.error || errJson.message || ''
        } catch {
          errorDetails = await res.text()
        }
        throw new Error(
          errorDetails
            ? `Godot returned HTTP ${res.status}: ${errorDetails}`
            : `Godot returned HTTP ${res.status}`
        )
      }
      const result = await res.json()
      if (result.success) {
        const fallbackElemCount = 'elements' in payload && Array.isArray((payload as OSMExportPayload).elements)
          ? (payload as OSMExportPayload).elements.length
          : 0
        lastTransferStats.value = {
          roads: result.stats?.roads ?? 0,
          buildings: result.stats?.buildings ?? 0,
          elements: result.stats?.elements ?? fallbackElemCount,
          savedPath: result.saved_path
        }
        isConnected.value = true
        return true
      } else {
        throw new Error(result.error || 'Unknown import error in Godot')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      lastTransferError.value = msg
      return false
    } finally {
      isSending.value = false
    }
  }

  async function sendBBoxToGodot(bbox: { west: number; south: number; east: number; north: number }): Promise<boolean> {
    return sendToGodot({
      bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
      source: 'overture'
    })
  }

  /**
   * Fetches GeoJSON from Godot bridge /api/fetch without generating a scene.
   */
  async function fetchGeoJsonFromGodot(bbox: { west: number; south: number; east: number; north: number }): Promise<Record<string, unknown> | null> {
    isSending.value = true
    lastTransferError.value = null
    try {
      const res = await fetch(`${godotUrl.value}/api/fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
          source: 'overture'
        })
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Godot fetch returned HTTP ${res.status}: ${text}`)
      }
      const result = await res.json()
      if (result.success && result.geojson) {
        isConnected.value = true
        return result.geojson as Record<string, unknown>
      }
      throw new Error(result.error || 'Failed to acquire GeoJSON from Godot bridge')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      lastTransferError.value = msg
      return null
    } finally {
      isSending.value = false
    }
  }

  function startHeartbeat(intervalMs = 6000) {
    checkConnection()
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(checkConnection, intervalMs)
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  return {
    godotUrl,
    godotPort,
    isConnected,
    isChecking,
    isSending,
    lastTransferStats,
    lastTransferError,
    checkConnection,
    sendToGodot,
    sendBBoxToGodot,
    fetchGeoJsonFromGodot,
    supportedServerVersions,
    isEditorPayload,
    startHeartbeat,
    stopHeartbeat
  }
}
