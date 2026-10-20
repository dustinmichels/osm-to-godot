<script setup lang="ts">
import { ViewMode } from '../composables/editor/types'

defineProps<{
  viewMode: ViewMode
  counts?: {
    roads: number
    buildings: number
    inferredWidths: number
    inferredFacilities: number
  }
}>()
</script>

<template>
  <div class="editor-legend" data-testid="editor-legend">
    <div class="legend-header">
      <span class="legend-title">Legend</span>
      <span class="view-indicator" :data-mode="viewMode">
        {{ viewMode === 'realistic' ? 'Realistic View (Surfaces)' : 'Data View (Lines & Outlines)' }}
      </span>
    </div>

    <div class="legend-items">
      <div class="legend-row">
        <span class="legend-swatch road-swatch"></span>
        <span class="legend-label">Road Carriageway</span>
      </div>
      <div class="legend-row">
        <span class="legend-swatch sidewalk-swatch"></span>
        <span class="legend-label">Sidewalk / Footway</span>
      </div>
      <div class="legend-row" data-testid="legend-row-bike-lane">
        <span class="legend-swatch bike-swatch bike-lane-swatch"></span>
        <span class="legend-label">
          On-Road Bike Lane
          <span class="legend-subtext">(attached road strip)</span>
        </span>
      </div>
      <div class="legend-row" data-testid="legend-row-cycleway">
        <span class="legend-swatch cycleway-swatch"></span>
        <span class="legend-label">
          Standalone Cycleway
          <span class="legend-subtext">(dedicated path / track)</span>
        </span>
      </div>
      <div class="legend-row">
        <span class="legend-swatch building-swatch"></span>
        <span class="legend-label">Building</span>
      </div>
      <div class="legend-row">
        <span class="legend-swatch inferred-swatch"></span>
        <span class="legend-label">
          Inferred Width / Facility
          <span class="legend-subtext">(estimated from road class or tags)</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-legend {
  position: absolute;
  bottom: 24px;
  left: 16px;
  background: rgba(30, 30, 36, 0.95);
  backdrop-filter: blur(4px);
  color: #f3f4f6;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.legend-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 6px;
}

.legend-title {
  font-weight: 700;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: #9ca3af;
}

.view-indicator {
  font-size: 11px;
  color: #60a5fa;
}

.legend-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.legend-swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  display: inline-block;
  flex-shrink: 0;
}

.road-swatch {
  background: #374151;
  border: 1px solid #6b7280;
}

.sidewalk-swatch {
  background: #9ca3af;
}

.bike-swatch,
.bike-lane-swatch {
  background: #10b981;
}

.cycleway-swatch {
  background: #059669;
  border: 1px dashed #34d399;
}
.building-swatch {
  background: #d97706;
}

.inferred-swatch {
  background: #f59e0b;
  border: 1px dashed #fbbf24;
}

.legend-label {
  display: flex;
  flex-direction: column;
  font-size: 12px;
}

.legend-subtext {
  font-size: 10px;
  color: #9ca3af;
}
</style>
