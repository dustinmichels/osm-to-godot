<script setup lang="ts">
import { ref } from 'vue'
import MapView from '@/components/MapView.vue'
import SearchBar from '@/components/SearchBar.vue'
import TelemetryPanel from '@/components/TelemetryPanel.vue'
import ExportControls from '@/components/ExportControls.vue'
import BasemapSelector from '@/components/BasemapSelector.vue'
import { useBBox } from '@/composables/useBBox'
import { parseUrlState, useUrlSync } from '@/composables/useUrlSync'
import type { CameraChangePayload } from '@/components/MapView.vue'

const mapViewRef = ref<InstanceType<typeof MapView> | null>(null)
const { initDefaultBBox, hasBBox, centroid, isSelectionMode, toggleSelectionMode, setBBox } = useBBox()

const initialUrlState = parseUrlState()
if (initialUrlState.bbox) {
  setBBox(initialUrlState.bbox)
}

const initialCenter: [number, number] = initialUrlState.center
  ? [initialUrlState.center.lon, initialUrlState.center.lat]
  : initialUrlState.bbox
    ? [
        (initialUrlState.bbox.west + initialUrlState.bbox.east) / 2,
        (initialUrlState.bbox.south + initialUrlState.bbox.north) / 2
      ]
    : [4.8952, 52.3702]

const initialZoom: number = initialUrlState.zoom ?? 15
const cameraZoom = ref(initialZoom)

function onCameraChange(payload: CameraChangePayload) {
  cameraZoom.value = Math.round(payload.zoom * 100) / 100
}

useUrlSync({
  cameraZoom,
  getMapCenter: () => mapViewRef.value?.getCenter() ?? null,
  onNavigate: (lon, lat) => {
    mapViewRef.value?.flyTo(lon, lat)
  }
})

const isCopied = ref(false)
let copyTimer: number | undefined

async function copyShareUrl() {
  try {
    await navigator.clipboard.writeText(window.location.href)
    isCopied.value = true
    clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      isCopied.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy URL:', err)
  }
}
interface PresetLocation {
  name: string
  subtitle: string
  lon: number
  lat: number
  radiusMeters: number
}

const PRESETS: PresetLocation[] = [
  {
    name: 'Amsterdam',
    subtitle: 'Canals & dense urban blocks',
    lon: 4.8952,
    lat: 52.3702,
    radiusMeters: 300
  },
  {
    name: 'Barcelona',
    subtitle: 'Octagonal grid blocks',
    lon: 2.1648,
    lat: 41.3912,
    radiusMeters: 300
  },
  {
    name: 'Manhattan',
    subtitle: 'Midtown skyscrapers',
    lon: -73.9855,
    lat: 40.7484,
    radiusMeters: 300
  },
  {
    name: 'Shibuya',
    subtitle: 'Tokyo crossing & transit',
    lon: 139.7016,
    lat: 35.6595,
    radiusMeters: 300
  }
]

function onSearchSelect(payload: {
  lon: number
  lat: number
  extent?: [number, number, number, number]
  label: string
}) {
  mapViewRef.value?.flyTo(payload.lon, payload.lat, payload.extent)
}

function applyPreset(preset: PresetLocation) {
  mapViewRef.value?.flyTo(preset.lon, preset.lat, undefined, preset.radiusMeters)
}

function resetBoxToCenter() {
  const center = mapViewRef.value?.getCenter() || [4.8952, 52.3702]
  initDefaultBBox(center[0], center[1], 300)
  mapViewRef.value?.zoomToBBox()
}
</script>

<template>
  <div class="app-root">
    <!-- Map Background -->
    <div class="map-layer">
      <MapView
        ref="mapViewRef"
        :initial-center="initialCenter"
        :initial-zoom="initialZoom"
        @camera-change="onCameraChange"
      />
    </div>

    <!-- Top Navigation Header -->
    <header class="app-header">
      <div class="brand">
        <div class="brand-badge">OSM</div>
        <div class="brand-text">
          <h1 class="brand-title">OSM to Godot</h1>
          <span class="brand-tag">3D Scene Extractor</span>
        </div>
      </div>

      <!-- Geocoder Search Bar -->
      <div class="header-search">
        <SearchBar
          :center-lat="centroid?.lat"
          :center-lon="centroid?.lon"
          @select="onSearchSelect"
        />
      </div>

      <!-- Top Toolbar Actions -->
      <div class="header-actions">
        <button
          type="button"
          class="action-btn"
          :class="{ 'is-active': isSelectionMode }"
          :title="isSelectionMode ? 'Click and drag on map to draw box' : 'Draw new selection rectangle'"
          @click="toggleSelectionMode"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
            <rect x="3" y="3" width="14" height="14" rx="2" stroke-width="1.8" stroke-dasharray="3 2" />
            <path d="M10 7v6M7 10h6" stroke-width="1.8" stroke-linecap="round" />
          </svg>
          <span>{{ isSelectionMode ? 'Drawing...' : 'Draw Box' }}</span>
        </button>

        <button
          v-if="hasBBox"
          type="button"
          class="action-btn"
          title="Center camera on current bounding box"
          @click="mapViewRef?.zoomToBBox()"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
            <circle cx="10" cy="10" r="6" stroke-width="1.8" />
            <path d="M10 2v3M10 15v3M2 10h3M15 10h3" stroke-width="1.8" stroke-linecap="round" />
          </svg>
          <span>Center</span>
        </button>

        <button
          type="button"
          class="action-btn action-btn-subtle"
          title="Reset box to center of screen"
          @click="resetBoxToCenter"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>Reset</span>
        </button>

        <button
          type="button"
          class="action-btn"
          :class="{ 'is-copied': isCopied }"
          title="Copy shareable link with current centerpoint and bounding box"
          @click="copyShareUrl"
        >
          <svg v-if="!isCopied" viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
            <path d="M9 11a4 4 0 005.657 0l2.828-2.829a4 4 0 00-5.657-5.656L10.5 3.843" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M11 9a4 4 0 00-5.657 0L2.515 11.828a4 4 0 005.657 5.657L9.5 16.157" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else viewBox="0 0 20 20" fill="none" stroke="currentColor" class="btn-icon">
            <path d="M4 10l4 4L16 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ isCopied ? 'Copied Link' : 'Copy Link' }}</span>
        </button>

        <BasemapSelector />
      </div>
    </header>

    <!-- Floating Left Sidebar Dock -->
    <aside class="sidebar-dock">
      <TelemetryPanel />
      <ExportControls />
    </aside>

    <!-- Example Buttons along Right Side -->
    <aside class="examples-dock">
      <div class="examples-header">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="examples-icon">
          <path d="M10 2l2.5 5.5L18 8.5l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1L10 2z" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
        <span class="examples-title">Examples</span>
      </div>
      <button
        v-for="p in PRESETS"
        :key="p.name"
        type="button"
        class="example-card-btn"
        :title="p.subtitle"
        @click="applyPreset(p)"
      >
        <div class="example-name">{{ p.name }}</div>
        <div class="example-sub">{{ p.subtitle }}</div>
      </button>
    </aside>
  </div>
</template>

<style>
/* Global resets & typography */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0d1117;
  color: #f1f5f9;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
</style>

<style scoped>
.app-root {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.map-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.app-header {
  position: absolute;
  top: 14px;
  left: 16px;
  right: 16px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  pointer-events: none;
  z-index: 25;
}

.app-header > * {
  pointer-events: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 6px 14px 6px 10px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.brand-badge {
  background: #2563eb;
  color: #ffffff;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.05em;
  padding: 3px 6px;
  border-radius: 4px;
}

.brand-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.1;
  color: #ffffff;
}

.brand-tag {
  font-size: 10px;
  color: #94a3b8;
  font-weight: 500;
}

.header-search {
  flex: 1;
  max-width: 480px;
  margin: 0 auto;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  font-size: 12.5px;
  font-weight: 600;
  padding: 8px 13px;
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition: all 0.15s ease;
}

.action-btn:hover {
  background: rgba(30, 36, 46, 0.98);
  border-color: rgba(255, 255, 255, 0.25);
  transform: translateY(-1px);
}

.action-btn.is-active {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
  box-shadow: 0 4px 18px rgba(37, 99, 235, 0.45);
}
.action-btn.is-copied {
  background: rgba(16, 185, 129, 0.2);
  border-color: rgba(52, 211, 153, 0.45);
  color: #34d399;
}


.action-btn-subtle {
  color: #94a3b8;
}

.action-btn-subtle:hover {
  color: #f1f5f9;
}

.btn-icon {
  width: 15px;
  height: 15px;
}

/* Examples Dock along Right Side */
.examples-dock {
  position: absolute;
  top: 76px;
  right: 16px;
  width: 170px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 20;
  pointer-events: auto;
}

.examples-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.examples-icon {
  width: 13px;
  height: 13px;
  color: #38bdf8;
}

.example-card-btn {
  background: rgba(18, 22, 28, 0.9);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 8px 11px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  transition: all 0.15s ease;
}

.example-card-btn:hover {
  background: rgba(30, 37, 48, 0.96);
  border-color: rgba(59, 130, 246, 0.4);
  transform: translateX(-2px);
  box-shadow: 0 4px 18px rgba(37, 99, 235, 0.25);
}

.example-name {
  font-size: 12px;
  font-weight: 600;
  color: #f1f5f9;
}

.example-sub {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebar-dock {
  position: absolute;
  top: 76px;
  left: 16px;
  width: 360px;
  max-height: calc(100vh - 92px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 20;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

@media (max-width: 900px) {
  .examples-dock {
    display: none;
  }
  .header-search {
    max-width: 240px;
  }
  .sidebar-dock {
    width: calc(100vw - 32px);
    max-height: 50vh;
  }
}
</style>
