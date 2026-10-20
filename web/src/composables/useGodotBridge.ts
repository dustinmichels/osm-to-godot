import { ref } from 'vue'
import type { OSMExportPayload } from '@/services/overpass'

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

  async function sendToGodot(payload: OSMExportPayload | Record<string, unknown>): Promise<boolean> {
    isSending.value = true
    lastTransferError.value = null

    try {
      const res = await fetch(`${godotUrl.value}/api/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Godot returned HTTP ${res.status}: ${text}`)
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
    startHeartbeat,
    stopHeartbeat
  }
}
