<script setup lang="ts">
import { ref } from 'vue'
import SearchBar from '@/components/SearchBar.vue'
import TelemetryPanel from '@/components/TelemetryPanel.vue'
import ExportControls from '@/components/ExportControls.vue'
import BasemapSelector from '@/components/BasemapSelector.vue'
import { useBBox, type BoundingBox } from '@/composables/useBBox'

interface Props {
  hasActiveProject?: boolean
  featureCount?: number
  activeSource?: string
}

withDefaults(defineProps<Props>(), {
  hasActiveProject: false,
  featureCount: 0,
  activeSource: 'overture'
})

const emit = defineEmits<{
  (e: 'flyTo', payload: {
    lon: number
    lat: number
    extent?: [number, number, number, number]
    radiusMeters?: number
    zoom?: number
    bbox?: BoundingBox
  }): void
  (e: 'zoomToBBox'): void
  (e: 'resetBox'): void
  (e: 'transitionToEditor'): void
}>()

const { hasBBox, centroid, isSelectionMode, toggleSelectionMode } = useBBox()

interface PresetLocation {
  name: string
  subtitle: string
  lon: number
  lat: number
  radiusMeters?: number
  zoom?: number
  bbox?: BoundingBox
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
  },
  {
    name: 'Medford-Y',
    subtitle: 'Medford Square fork & intersection',
    lon: -71.110368,
    lat: 42.415261,
    zoom: 17.16,
    bbox: {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
  }
]

function applyPreset(preset: PresetLocation) {
  emit('flyTo', {
    lon: preset.lon,
    lat: preset.lat,
    radiusMeters: preset.radiusMeters,
    zoom: preset.zoom,
    bbox: preset.bbox
  })
}

function onSearchSelect(payload: {
  lon: number
  lat: number
  extent?: [number, number, number, number]
  label: string
}) {
  emit('flyTo', {
    lon: payload.lon,
    lat: payload.lat,
    extent: payload.extent
  })
}

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
</script>

<template>
  <div class="area-selector-view">
    <!-- Top Navigation Header -->
    <header class="selector-header">
      <div class="brand">
        <div class="brand-badge">2D</div>
        <div class="brand-text">
          <h1 class="brand-title">City 2D Studio</h1>
          <span class="brand-step">Step 1: Search &amp; Select Area</span>
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

      <!-- Top Actions -->
      <div class="header-actions">
        <button
          type="button"
          class="action-btn action-btn-link"
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
          <span>{{ isCopied ? 'Copied' : 'Share Link' }}</span>
        </button>

        <BasemapSelector />

        <!-- Quick Switch to Editor if Project is already loaded -->
        <button
          v-if="hasActiveProject"
          type="button"
          class="action-btn action-btn-primary to-editor-btn"
          title="Return to the active 2D Editor project"
          @click="emit('transitionToEditor')"
        >
          <span>Open 2D Editor</span>
          <span class="feature-count-badge">{{ featureCount }}</span>
          <svg viewBox="0 0 20 20" fill="currentColor" class="btn-icon-right">
            <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Floating Left Sidebar for Area Selection -->
    <aside class="selector-sidebar">
      <!-- Quick Location Presets Card -->
      <section class="panel-section presets-card">
        <div class="section-header">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="section-icon">
            <path d="M10 2l2.5 5.5L18 8.5l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1L10 2z" stroke-width="1.6" stroke-linejoin="round" />
          </svg>
          <span class="section-title">Quick Presets</span>
        </div>
        <div class="presets-row">
          <button
            v-for="p in PRESETS"
            :key="p.name"
            type="button"
            class="preset-chip"
            :title="p.subtitle"
            @click="applyPreset(p)"
          >
            <span class="preset-name">{{ p.name }}</span>
          </button>
        </div>
      </section>

      <!-- Bounding Box Action Toolbar Card -->
      <section class="panel-section bbox-tools-card">
        <div class="section-header">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="section-icon">
            <rect x="3" y="3" width="14" height="14" rx="2" stroke-width="1.8" stroke-dasharray="3 2" />
          </svg>
          <span class="section-title">Bounding Box Tool</span>
        </div>
        <div class="bbox-actions-row">
          <button
            type="button"
            class="bbox-tool-btn"
            :class="{ 'is-active': isSelectionMode }"
            :title="isSelectionMode ? 'Click and drag on map to draw box' : 'Draw new selection rectangle'"
            @click="toggleSelectionMode"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="tool-icon">
              <rect x="3" y="3" width="14" height="14" rx="2" stroke-width="1.8" stroke-dasharray="3 2" />
              <path d="M10 7v6M7 10h6" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            <span>{{ isSelectionMode ? 'Drawing...' : 'Draw Box' }}</span>
          </button>

          <button
            v-if="hasBBox"
            type="button"
            class="bbox-tool-btn"
            title="Center camera on current bounding box"
            @click="emit('zoomToBBox')"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="tool-icon">
              <circle cx="10" cy="10" r="6" stroke-width="1.8" />
              <path d="M10 2v3M10 15v3M2 10h3M15 10h3" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            <span>Center</span>
          </button>

          <button
            type="button"
            class="bbox-tool-btn bbox-tool-btn-subtle"
            title="Reset box to center of screen"
            @click="emit('resetBox')"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="tool-icon">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>Reset</span>
          </button>
        </div>
      </section>

      <!-- Telemetry Readout -->
      <TelemetryPanel />

      <!-- Data Acquisition & Transition to Editor -->
      <ExportControls />
    </aside>
  </div>
</template>

<style scoped>
.area-selector-view {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
}

.selector-header {
  position: absolute;
  top: 14px;
  left: 16px;
  right: 16px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  pointer-events: none;
  z-index: 25;
}

.selector-header > * {
  pointer-events: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(14px);
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
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.15;
  color: #ffffff;
}

.brand-step {
  font-size: 10px;
  color: #38bdf8;
  font-weight: 600;
  letter-spacing: 0.02em;
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
  display: inline-flex;
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

.action-btn.is-copied {
  background: rgba(16, 185, 129, 0.2);
  border-color: rgba(52, 211, 153, 0.45);
  color: #34d399;
}

.action-btn-primary {
  background: linear-gradient(135deg, #2563eb, #1d4ed8);
  border-color: #3b82f6;
  color: #ffffff;
  box-shadow: 0 4px 18px rgba(37, 99, 235, 0.4);
}

.action-btn-primary:hover {
  background: linear-gradient(135deg, #1d4ed8, #1e40af);
  border-color: #60a5fa;
  box-shadow: 0 6px 22px rgba(37, 99, 235, 0.55);
}

.feature-count-badge {
  background: rgba(255, 255, 255, 0.2);
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 700;
}

.btn-icon {
  width: 15px;
  height: 15px;
}

.btn-icon-right {
  width: 16px;
  height: 16px;
  margin-left: -2px;
}

.selector-sidebar {
  position: absolute;
  top: 76px;
  left: 16px;
  width: 380px;
  max-height: calc(100vh - 92px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: auto;
  z-index: 20;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

.panel-section {
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.section-icon {
  width: 14px;
  height: 14px;
  color: #38bdf8;
}

.presets-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.preset-chip {
  background: rgba(30, 41, 59, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #f1f5f9;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 11px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.preset-chip:hover {
  background: rgba(51, 65, 85, 0.9);
  border-color: rgba(56, 189, 248, 0.4);
  color: #38bdf8;
  transform: translateY(-1px);
}

.bbox-actions-row {
  display: flex;
  gap: 6px;
}

.bbox-tool-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(30, 41, 59, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.bbox-tool-btn:hover {
  background: rgba(51, 65, 85, 0.9);
  border-color: rgba(255, 255, 255, 0.25);
}

.bbox-tool-btn.is-active {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
  box-shadow: 0 2px 10px rgba(37, 99, 235, 0.45);
}

.bbox-tool-btn-subtle {
  color: #94a3b8;
}

.bbox-tool-btn-subtle:hover {
  color: #f1f5f9;
}

.tool-icon {
  width: 14px;
  height: 14px;
}

@media (max-width: 900px) {
  .selector-sidebar {
    width: calc(100vw - 32px);
    max-height: 55vh;
  }
  .header-search {
    max-width: 220px;
  }
}
</style>
