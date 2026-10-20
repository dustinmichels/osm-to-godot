<script setup lang="ts">
import { computed } from 'vue'
import { useBBox } from '@/composables/useBBox'

const {
  normalizedBBox,
  centroid,
  dimensions,
  areaKm2,
  isWarningSize,
  isDangerSize,
  setBBox
} = useBBox()

function updateCoord(key: 'west' | 'south' | 'east' | 'north', value: string) {
  if (!normalizedBBox.value) return
  const num = parseFloat(value)
  if (isNaN(num)) return

  const updated = { ...normalizedBBox.value, [key]: num }
  setBBox(updated)
}

const formattedArea = computed(() => {
  if (areaKm2.value < 0.01) {
    return `${(areaKm2.value * 1_000_000).toFixed(0)} m²`
  }
  return `${areaKm2.value.toFixed(3)} km²`
})

const formattedDimensions = computed(() => {
  const d = dimensions.value
  if (!d) return { width: '0 m', height: '0 m' }
  const w = d.widthMeters >= 1000 ? `${(d.widthMeters / 1000).toFixed(2)} km` : `${d.widthMeters.toFixed(0)} m`
  const h = d.heightMeters >= 1000 ? `${(d.heightMeters / 1000).toFixed(2)} km` : `${d.heightMeters.toFixed(0)} m`
  return { width: w, height: h }
})
</script>

<template>
  <div class="telemetry-panel">
    <div class="panel-header">
      <div class="panel-title-row">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="header-icon">
          <rect x="3" y="3" width="14" height="14" rx="2" stroke-width="1.8" />
          <path d="M10 3v14M3 10h14" stroke-width="1.8" />
        </svg>
        <span class="panel-title">Selected Area</span>
      </div>

      <!-- Area Tag & Status Badge -->
      <div
        v-if="normalizedBBox"
        class="area-badge"
        :class="{ 'is-warning': isWarningSize && !isDangerSize, 'is-danger': isDangerSize }"
      >
        <span class="area-value">{{ formattedArea }}</span>
      </div>
    </div>

    <div v-if="normalizedBBox" class="panel-body">
      <!-- Clean Dimensions & Center Stats -->
      <div class="stats-summary">
        <div class="stat-item">
          <span class="stat-label">Dimensions</span>
          <span class="stat-val">{{ formattedDimensions.width }} × {{ formattedDimensions.height }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Center</span>
          <span class="stat-val font-mono">{{ centroid?.lat.toFixed(4) }}°, {{ centroid?.lon.toFixed(4) }}°</span>
        </div>
      </div>

      <!-- Collapsible Coordinates Fine-Tuner -->
      <details class="coords-details">
        <summary class="coords-summary">
          <span>Edit Coordinates</span>
          <svg viewBox="0 0 20 20" fill="currentColor" class="chevron-icon">
            <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
          </svg>
        </summary>
        <div class="coords-editor">
          <div class="coord-field">
            <label>North (max lat)</label>
            <input
              type="number"
              step="0.0001"
              :value="normalizedBBox.north.toFixed(5)"
              class="coord-input"
              @change="updateCoord('north', ($event.target as HTMLInputElement).value)"
            />
          </div>

          <div class="coord-row-split">
            <div class="coord-field">
              <label>West (min lon)</label>
              <input
                type="number"
                step="0.0001"
                :value="normalizedBBox.west.toFixed(5)"
                class="coord-input"
                @change="updateCoord('west', ($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="coord-field">
              <label>East (max lon)</label>
              <input
                type="number"
                step="0.0001"
                :value="normalizedBBox.east.toFixed(5)"
                class="coord-input"
                @change="updateCoord('east', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>

          <div class="coord-field">
            <label>South (min lat)</label>
            <input
              type="number"
              step="0.0001"
              :value="normalizedBBox.south.toFixed(5)"
              class="coord-input"
              @change="updateCoord('south', ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
      </details>

      <!-- Size Alerts -->
      <div v-if="isDangerSize" class="alert-box alert-danger">
        <svg viewBox="0 0 20 20" fill="currentColor" class="alert-icon">
          <path
            fill-rule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clip-rule="evenodd"
          />
        </svg>
        <div>
          <div class="alert-title">Area exceeds 10 km² limit</div>
          <div class="alert-desc">Queries over 10 km² risk server timeout. Downscale the box.</div>
        </div>
      </div>

      <div v-else-if="isWarningSize" class="alert-box alert-warning">
        <svg viewBox="0 0 20 20" fill="currentColor" class="alert-icon">
          <path
            fill-rule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
            clip-rule="evenodd"
          />
        </svg>
        <div>
          <div class="alert-title">Large selection (> 2.5 km²)</div>
          <div class="alert-desc">Data download might take 5–15s and produce 50k+ nodes.</div>
        </div>
      </div>
    </div>

    <div v-else class="empty-state">
      <p>No area selected. Click "Draw Box" or drag on the map.</p>
    </div>
  </div>
</template>

<style scoped>
.telemetry-panel {
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
  color: #f1f5f9;
  font-family: inherit;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  width: 17px;
  height: 17px;
  color: #3b82f6;
}

.panel-title {
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.area-badge {
  background: rgba(59, 130, 246, 0.18);
  border: 1px solid rgba(59, 130, 246, 0.4);
  color: #93c5fd;
  font-size: 12px;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  padding: 2px 8px;
  border-radius: 6px;
}

.area-badge.is-warning {
  background: rgba(245, 158, 11, 0.18);
  border-color: rgba(245, 158, 11, 0.45);
  color: #fcd34d;
}

.area-badge.is-danger {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}

.stats-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-label {
  font-size: 11.5px;
  color: #94a3b8;
  font-weight: 500;
}

.stat-val {
  font-size: 12.5px;
  font-weight: 600;
  color: #f8fafc;
}

.font-mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
}

.coords-details {
  margin-bottom: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  overflow: hidden;
}

.coords-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 11.5px;
  color: #94a3b8;
  cursor: pointer;
  user-select: none;
  background: rgba(255, 255, 255, 0.02);
  transition: background 0.15s ease, color 0.15s ease;
}

.coords-summary:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
}

.chevron-icon {
  width: 14px;
  height: 14px;
  transition: transform 0.2s ease;
}

.coords-details[open] .chevron-icon {
  transform: rotate(180deg);
}

.coords-details .coords-editor {
  padding: 10px 12px;
  margin-bottom: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.coords-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.coord-row-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.coord-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.coord-field label {
  font-size: 10.5px;
  color: #94a3b8;
  font-weight: 500;
}

.coord-input {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 8px;
  color: #f8fafc;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s ease;
}

.coord-input:focus {
  border-color: #3b82f6;
}

.alert-box {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
}

.alert-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  margin-top: 1px;
}

.alert-title {
  font-weight: 600;
  margin-bottom: 2px;
}

.alert-desc {
  opacity: 0.9;
  line-height: 1.35;
}

.alert-warning {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: #fef3c7;
}

.alert-warning .alert-icon {
  color: #fbbf24;
}

.alert-danger {
  background: rgba(239, 68, 68, 0.14);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fee2e2;
}

.alert-danger .alert-icon {
  color: #f87171;
}

.empty-state {
  color: #94a3b8;
  font-size: 12.5px;
  line-height: 1.4;
  padding: 12px 0;
}
</style>
