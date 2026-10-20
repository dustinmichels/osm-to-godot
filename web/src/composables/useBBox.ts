import { ref, computed } from 'vue'

export interface BoundingBox {
  west: number  // minLon
  south: number // minLat
  east: number  // maxLon
  north: number // maxLat
}

export type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface BBoxHandle {
  type: HandleType
  coordinates: [number, number] // [lon, lat]
  cursor: string
}

const EARTH_RADIUS_METERS = 6378137

// Global reactive state so MapView, TelemetryPanel, and ExportControls stay in sync
const currentBBox = ref<BoundingBox | null>(null)
const isDrawing = ref(false)
const isSelectionMode = ref(false)
const activeHandle = ref<HandleType | null>(null)
export function useBBox() {
  const hasBBox = computed(() => currentBBox.value !== null)

  const normalizedBBox = computed<BoundingBox | null>(() => {
    if (!currentBBox.value) return null
    const { west, south, east, north } = currentBBox.value
    return {
      west: Math.min(west, east),
      south: Math.min(south, north),
      east: Math.max(west, east),
      north: Math.max(south, north)
    }
  })

  const centroid = computed<{ lon: number; lat: number; lonRad: number; latRad: number } | null>(() => {
    const box = normalizedBBox.value
    if (!box) return null
    const lon = (box.west + box.east) / 2
    const lat = (box.south + box.north) / 2
    return {
      lon,
      lat,
      lonRad: (lon * Math.PI) / 180,
      latRad: (lat * Math.PI) / 180
    }
  })

  // Dimensions in meters
  const dimensions = computed<{ widthMeters: number; heightMeters: number } | null>(() => {
    const box = normalizedBBox.value
    const c = centroid.value
    if (!box || !c) return null

    const dLonRad = ((box.east - box.west) * Math.PI) / 180
    const dLatRad = ((box.north - box.south) * Math.PI) / 180

    const widthMeters = EARTH_RADIUS_METERS * dLonRad * Math.cos(c.latRad)
    const heightMeters = EARTH_RADIUS_METERS * dLatRad

    return {
      widthMeters: Math.max(0, widthMeters),
      heightMeters: Math.max(0, heightMeters)
    }
  })

  // Area in square kilometers
  const areaKm2 = computed<number>(() => {
    const dims = dimensions.value
    if (!dims) return 0
    return (dims.widthMeters * dims.heightMeters) / 1_000_000
  })

  const isWarningSize = computed<boolean>(() => areaKm2.value > 2.5)
  const isDangerSize = computed<boolean>(() => areaKm2.value > 10.0)

  // GeoJSON Polygon representation for MapLibre layer
  const polygonGeoJSON = computed(() => {
    const box = normalizedBBox.value
    if (!box) return null

    const { west, south, east, north } = box
    const coordinates = [
      [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
        [west, north] // close ring
      ]
    ]

    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Polygon' as const,
        coordinates
      }
    }
  })

  // Handles placed around the perimeter
  const handles = computed<BBoxHandle[]>(() => {
    const box = normalizedBBox.value
    if (!box) return []
    const { west, south, east, north } = box
    const midLon = (west + east) / 2
    const midLat = (south + north) / 2

    return [
      { type: 'nw', coordinates: [west, north], cursor: 'nwse-resize' },
      { type: 'n', coordinates: [midLon, north], cursor: 'ns-resize' },
      { type: 'ne', coordinates: [east, north], cursor: 'nesw-resize' },
      { type: 'e', coordinates: [east, midLat], cursor: 'ew-resize' },
      { type: 'se', coordinates: [east, south], cursor: 'nwse-resize' },
      { type: 's', coordinates: [midLon, south], cursor: 'ns-resize' },
      { type: 'sw', coordinates: [west, south], cursor: 'nesw-resize' },
      { type: 'w', coordinates: [west, midLat], cursor: 'ew-resize' }
    ]
  })

  const handlesGeoJSON = computed(() => {
    return {
      type: 'FeatureCollection' as const,
      features: handles.value.map((h) => ({
        type: 'Feature' as const,
        properties: {
          handleType: h.type,
          cursor: h.cursor
        },
        geometry: {
          type: 'Point' as const,
          coordinates: h.coordinates
        }
      }))
    }
  })

  function setBBox(box: BoundingBox | null) {
    if (!box) {
      currentBBox.value = null
      return
    }
    currentBBox.value = {
      west: Number(box.west.toFixed(6)),
      south: Number(box.south.toFixed(6)),
      east: Number(box.east.toFixed(6)),
      north: Number(box.north.toFixed(6))
    }
  }

  function updateHandlePosition(handle: HandleType, lon: number, lat: number) {
    if (!currentBBox.value) return
    const box = { ...currentBBox.value }

    switch (handle) {
      case 'nw':
        box.west = lon
        box.north = lat
        break
      case 'n':
        box.north = lat
        break
      case 'ne':
        box.east = lon
        box.north = lat
        break
      case 'e':
        box.east = lon
        break
      case 'se':
        box.east = lon
        box.south = lat
        break
      case 's':
        box.south = lat
        break
      case 'sw':
        box.west = lon
        box.south = lat
        break
      case 'w':
        box.west = lon
        break
    }

    currentBBox.value = box
  }

  function toggleSelectionMode() {
    isSelectionMode.value = !isSelectionMode.value
  }

  function clearBBox() {
    currentBBox.value = null
    activeHandle.value = null
    isDrawing.value = false
    isSelectionMode.value = false
  }

  // Pre-seed a default bbox around an urban area (e.g. 600m x 600m)
  function initDefaultBBox(centerLon = 4.8952, centerLat = 52.3702, radiusMeters = 300) {
    const dLatRad = radiusMeters / EARTH_RADIUS_METERS
    const dLonRad = radiusMeters / (EARTH_RADIUS_METERS * Math.cos((centerLat * Math.PI) / 180))
    const dLat = (dLatRad * 180) / Math.PI
    const dLon = (dLonRad * 180) / Math.PI

    setBBox({
      west: centerLon - dLon,
      south: centerLat - dLat,
      east: centerLon + dLon,
      north: centerLat + dLat
    })
  }
  return {
    currentBBox,
    normalizedBBox,
    hasBBox,
    centroid,
    dimensions,
    areaKm2,
    isWarningSize,
    isDangerSize,
    polygonGeoJSON,
    handles,
    handlesGeoJSON,
    isDrawing,
    isSelectionMode,
    activeHandle,
    setBBox,
    updateHandlePosition,
    clearBBox,
    toggleSelectionMode,
    initDefaultBBox
  }
}
