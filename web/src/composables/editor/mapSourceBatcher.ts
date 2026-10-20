/**
 * Utility for batching GeoJSONSource updates to the MapLibre map instance via requestAnimationFrame / microtask.
 * Avoids redundant setData serialization and thrashing during high-frequency edits or rapid state transitions.
 */

export interface GeoJSONSourceLike {
  setData: (data: GeoJSON.GeoJSON) => void
}

export interface MapSourceBatcher {
  scheduleUpdate: (sourceId: string, getSource: () => GeoJSONSourceLike | undefined, getData: () => GeoJSON.GeoJSON) => void
  flushUpdates: () => void
  cancelPending: () => void
}

export function createMapSourceBatcher(): MapSourceBatcher {
  let pendingUpdates = new Map<string, { getSource: () => GeoJSONSourceLike | undefined; getData: () => GeoJSON.GeoJSON }>()
  let rafId: number | null = null

  function flushUpdates() {
    if (rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      } else if (typeof clearTimeout === 'function') {
        clearTimeout(rafId)
      }
      rafId = null
    }

    if (pendingUpdates.size === 0) return

    const updates = pendingUpdates
    pendingUpdates = new Map()

    for (const [, { getSource, getData }] of updates) {
      try {
        const source = getSource()
        if (source) {
          source.setData(getData())
        }
      } catch {
        // Source may have been unmounted or destroyed
      }
    }
  }

  function scheduleUpdate(
    sourceId: string,
    getSource: () => GeoJSONSourceLike | undefined,
    getData: () => GeoJSON.GeoJSON
  ) {
    pendingUpdates.set(sourceId, { getSource, getData })

    if (rafId === null) {
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(() => {
          rafId = null
          flushUpdates()
        })
      } else if (typeof setTimeout === 'function') {
        rafId = setTimeout(() => {
          rafId = null
          flushUpdates()
        }, 0) as unknown as number
      } else {
        flushUpdates()
      }
    }
  }

  function cancelPending() {
    if (rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      } else if (typeof clearTimeout === 'function') {
        clearTimeout(rafId)
      }
      rafId = null
    }
    pendingUpdates.clear()
  }

  return {
    scheduleUpdate,
    flushUpdates,
    cancelPending
  }
}
