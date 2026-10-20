import { ref, computed } from 'vue'
import type { StyleSpecification } from 'maplibre-gl'

export type MapStyleId =
  | 'neutral-muted'
  | 'none-hidden'
  | 'vector-liberty'
  | 'vector-voyager'
  | 'vector-dark'
  | 'raster-osm'

export type BasemapStatus = 'available' | 'loading' | 'degraded' | 'offline' | 'fallback'

export interface MapStyleOption {
  id: MapStyleId
  label: string
  shortLabel: string
  description: string
  type: 'neutral' | 'hidden' | 'vector' | 'raster'
  style: string | StyleSpecification
}

export const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    'osm-raster': {
      type: 'raster',
      tiles: [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }
  },
  layers: [
    {
      id: 'osm-raster-layer',
      type: 'raster',
      source: 'osm-raster',
      minzoom: 0,
      maxzoom: 19
    }
  ]
}

export const NEUTRAL_MUTED_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background-neutral',
      type: 'background',
      paint: {
        'background-color': '#181b20'
      }
    }
  ]
}

export const HIDDEN_BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background-hidden',
      type: 'background',
      paint: {
        'background-color': '#0d1117'
      }
    }
  ]
}
export const MAP_STYLES: MapStyleOption[] = [
  {
    id: 'neutral-muted',
    label: 'Neutral Muted',
    shortLabel: 'Neutral',
    description: 'Clean solid background so basemap tiles never look like editable features',
    type: 'neutral',
    style: NEUTRAL_MUTED_STYLE
  },
  {
    id: 'none-hidden',
    label: 'Hidden (No Basemap)',
    shortLabel: 'Hidden',
    description: 'Deep black background with basemap tiles completely hidden',
    type: 'hidden',
    style: HIDDEN_BLANK_STYLE
  },
  {
    id: 'vector-liberty',
    label: 'Vector (Liberty)',
    shortLabel: 'Vector',
    description: 'Detailed OSM vector map with 3D buildings & hillshading',
    type: 'vector',
    style: 'https://tiles.openfreemap.org/styles/liberty'
  },
  {
    id: 'vector-voyager',
    label: 'Vector (Voyager)',
    shortLabel: 'Voyager',
    description: 'CARTO clean vector style with subtle pastel landcover',
    type: 'vector',
    style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
  },
  {
    id: 'vector-dark',
    label: 'Vector (Dark)',
    shortLabel: 'Dark',
    description: 'CARTO high-contrast dark vector theme',
    type: 'vector',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
  },
  {
    id: 'raster-osm',
    label: 'Raster OSM',
    shortLabel: 'Raster OSM',
    description: 'Standard OpenStreetMap raster tiles',
    type: 'raster',
    style: OSM_RASTER_STYLE
  }
]

const STORAGE_KEY = 'osm_to_godot_map_style'

function getInitialStyleId(): MapStyleId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && MAP_STYLES.some(s => s.id === saved)) {
      return saved as MapStyleId
    }
  } catch {
    // Ignore localStorage access failures (SSR / incognito sandbox)
  }
  // Default to vector-liberty
  return 'vector-liberty'
}

// Global state across components
const currentStyleId = ref<MapStyleId>(getInitialStyleId())
const basemapStatus = ref<BasemapStatus>('available')
const basemapError = ref<string | null>(null)
const basemapNoticeDismissed = ref(false)

export function useMapStyle() {
  const currentStyle = computed<MapStyleOption>(() => {
    return MAP_STYLES.find(s => s.id === currentStyleId.value) || MAP_STYLES[0]
  })

  const isVector = computed<boolean>(() => currentStyle.value.type === 'vector')
  const isLocalStyle = computed<boolean>(() => currentStyle.value.type === 'neutral' || currentStyle.value.type === 'hidden')
  const isExternalStyle = computed<boolean>(() => !isLocalStyle.value)
  function setStyle(id: MapStyleId) {
    if (!MAP_STYLES.some(s => s.id === id)) return
    currentStyleId.value = id
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // Ignore storage errors
    }
    if (isLocalStyle.value) {
      basemapStatus.value = 'available'
      basemapError.value = null
    } else {
      basemapStatus.value = 'loading'
    }
    basemapNoticeDismissed.value = false
  }

  function reportBasemapFailure(reason: string, options?: { autoFallback?: boolean }) {
    basemapNoticeDismissed.value = false
    if (options?.autoFallback) {
      setStyle('neutral-muted')
      basemapStatus.value = 'fallback'
    } else {
      basemapStatus.value = isExternalStyle.value ? 'degraded' : 'available'
    }
    basemapError.value = reason
  }
  function reportBasemapSuccess() {
    basemapError.value = null
    basemapStatus.value = 'available'
  }

  function dismissBasemapNotice() {
    basemapNoticeDismissed.value = true
  }

  function resetBasemapStatus() {
    basemapStatus.value = 'available'
    basemapError.value = null
    basemapNoticeDismissed.value = false
  }

  function toggleType() {
    if (isVector.value) {
      setStyle('raster-osm')
    } else {
      setStyle('vector-liberty')
    }
  }

  return {
    styles: MAP_STYLES,
    currentStyleId,
    currentStyle,
    isVector,
    isLocalStyle,
    isExternalStyle,
    basemapStatus,
    basemapError,
    basemapNoticeDismissed,
    reportBasemapFailure,
    reportBasemapSuccess,
    dismissBasemapNotice,
    resetBasemapStatus,
    setStyle,
    toggleType
  }
}
