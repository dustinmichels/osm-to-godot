<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useBBox } from '@/composables/useBBox'
import { useOverpass } from '@/composables/useOverpass'
import { useOverture } from '@/composables/useOverture'
import { useGodotBridge } from '@/composables/useGodotBridge'

const { normalizedBBox, hasBBox, isDangerSize, areaKm2 } = useBBox()
const {
  isLoading: isOsmLoading,
  statusMessage: osmStatusMessage,
  errorMessage: osmErrorMessage,
  lastExportPayload: lastOsmPayload,
  executeExport: executeOsmExport,
  downloadJsonFile: downloadOsmJson
} = useOverpass()

const {
  isLoading: isOvertureLoading,
  statusMessage: overtureStatusMessage,
  errorMessage: overtureErrorMessage,
  lastExportPayload: lastOverturePayload,
  getCachedPreset: getCachedOverturePreset,
  executeExport: executeOvertureExport,
  downloadGeoJsonFile: downloadOvertureGeoJson
} = useOverture()

const isLoading = computed(() => (dataSource.value === 'osm' ? isOsmLoading.value : isOvertureLoading.value))
const statusMessage = computed(() => (dataSource.value === 'osm' ? osmStatusMessage.value : overtureStatusMessage.value))
const errorMessage = computed(() => (dataSource.value === 'osm' ? osmErrorMessage.value : overtureErrorMessage.value))
const {
  isConnected,
  isSending,
  godotPort,
  lastTransferStats,
  lastTransferError,
  sendToGodot,
  sendBBoxToGodot,
  startHeartbeat,
  stopHeartbeat
} = useGodotBridge()

onMounted(() => {
  startHeartbeat()
})

onUnmounted(() => {
  stopHeartbeat()
})

const showConfirmModal = ref(false)
const pendingAction = ref<'godot' | 'download'>('godot')
const forceFallback = ref(false)
const dataSource = ref<'overture' | 'osm'>('overture')

watch(
  [normalizedBBox, dataSource],
  ([box, src]) => {
    if (src === 'overture' && box) {
      const cached = getCachedOverturePreset(box)
      if (cached) {
        lastOverturePayload.value = cached.payload
        overtureStatusMessage.value = `Loaded cached Overture data (${cached.payload.features.length} features, offline)!`
        overtureErrorMessage.value = null
      } else if (lastOverturePayload.value) {
        lastOverturePayload.value = null
        overtureStatusMessage.value = ''
      }
    }
  },
  { immediate: true }
)

function onActionClick(action: 'godot' | 'download') {
  if (!hasBBox.value) return

  if (isDangerSize.value) {
    pendingAction.value = action
    showConfirmModal.value = true
    return
  }

  executeAction(action)
}

async function executeAction(action: 'godot' | 'download') {
  showConfirmModal.value = false
  const box = normalizedBBox.value
  if (!box) return

  if (dataSource.value === 'overture') {
    let payload = lastOverturePayload.value
    if (!payload) {
      payload = await executeOvertureExport()
    }

    if (payload) {
      if (action === 'godot') {
        await sendToGodot(payload)
      } else {
        const cached = getCachedOverturePreset(box)
        const filename = cached ? `${cached.name}_overture.geojson` : undefined
        downloadOvertureGeoJson(payload, filename)
      }
      return
    }

    // Fallback when not cached:
    if (action === 'godot') {
      await sendBBoxToGodot(box)
    } else {
      const bboxStr = `${box.west},${box.south},${box.east},${box.north}`
      const info = {
        metadata: {
          source: 'Overture Maps Foundation',
          bbox: [box.west, box.south, box.east, box.north],
          command: `mise run fetch-overture --bbox="${bboxStr}"`
        }
      }
      const blob = new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `overture_bbox_${box.south.toFixed(4)}_${box.west.toFixed(4)}.json`
      a.click()
      URL.revokeObjectURL(url)
    }
    return
  }

  // OSM Overpass path
  let payload = lastOsmPayload.value
  if (!payload) {
    payload = await executeOsmExport({ forceFallback: forceFallback.value })
  }
  if (!payload) return

  if (action === 'godot') {
    await sendToGodot(payload)
  } else {
    downloadOsmJson(payload)
  }
}
</script>

<template>
  <div class="export-controls-card">
    <div class="card-header">
      <div class="header-icon-wrap">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" class="header-icon">
          <path d="M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2M10 3v10M6 9l4 4 4-4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="header-text-block">
        <h3 class="card-title">Godot 3D Export</h3>
        <p class="card-sub">Extract road ribbons & 3D buildings</p>
      </div>
      <div class="godot-badge" :class="{ 'is-connected': isConnected }">
        <span class="badge-dot" />
        <span>{{ isConnected ? `Godot :${godotPort}` : 'Offline' }}</span>
      </div>
    </div>

    <!-- Source Selector -->
    <div class="source-toggle-row">
      <button
        type="button"
        class="source-tab-btn"
        :class="{ active: dataSource === 'overture' }"
        @click="dataSource = 'overture'"
      >
        🦆 Overture Maps
      </button>
      <button
        type="button"
        class="source-tab-btn"
        :class="{ active: dataSource === 'osm' }"
        @click="dataSource = 'osm'"
      >
        🌐 OSM Overpass
      </button>
    </div>

    <!-- Fallback Switch (OSM only) -->
    <div v-if="dataSource === 'osm'" class="fallback-toggle">
      <label class="toggle-label">
        <input v-model="forceFallback" type="checkbox" :disabled="isLoading" />
        <span class="toggle-text">Use OSM 0.6 API directly (fast for tiny boxes)</span>
      </label>
    </div>
    <!-- Action Buttons -->
    <div class="actions-row">
      <button
        type="button"
        class="primary-godot-btn"
        :class="{ 'is-loading': isLoading || isSending, 'is-linked': isConnected }"
        :disabled="!hasBBox || isLoading || isSending"
        @click="onActionClick('godot')"
      >
        <span v-if="isLoading || isSending" class="btn-spinner" />
        <svg v-else viewBox="0 0 20 20" fill="currentColor" class="btn-icon">
          <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
        </svg>
        <span>{{ isSending ? 'Sending to Godot...' : (isLoading ? 'Extracting Data...' : '⚡ Send to Godot') }}</span>
      </button>

      <button
        type="button"
        class="secondary-export-btn"
        :disabled="!hasBBox || isLoading || isSending"
        @click="onActionClick('download')"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" class="btn-icon-sub">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
        <span>{{ dataSource === 'overture' ? 'Download GeoJSON' : 'Download JSON' }}</span>
      </button>
    </div>

    <!-- Direct Godot Transfer Success Notice -->
    <div v-if="lastTransferStats" class="transfer-success-box">
      <div class="transfer-badge">✓ Sent to Godot</div>
      <div class="transfer-detail">
        Imported <strong>{{ lastTransferStats.roads }}</strong> roads &amp; <strong>{{ lastTransferStats.buildings }}</strong> buildings into Godot!
      </div>
    </div>

    <!-- Direct Godot Transfer Error Notice -->
    <div v-if="lastTransferError" class="transfer-error-box">
      <span class="transfer-err-label">Godot note:</span> {{ lastTransferError }}
    </div>

    <!-- Status / Error Messages -->
    <div v-if="statusMessage && !errorMessage" class="status-banner">
      <span class="status-dot" :class="{ 'is-pulse': isLoading }" />
      <span class="status-text">{{ statusMessage }}</span>
    </div>

    <div v-if="errorMessage" class="error-banner">
      <svg viewBox="0 0 20 20" fill="currentColor" class="error-icon">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
      </svg>
      <span>{{ errorMessage }}</span>
    </div>

    <!-- Export Summary Card -->
    <!-- OSM Export Summary Card -->
    <div v-if="dataSource === 'osm' && lastOsmPayload" class="summary-box">
      <div class="summary-header">
        <span class="summary-title">Export Succeeded</span>
        <button
          type="button"
          class="re-download-btn"
          @click="downloadOsmJson(lastOsmPayload!)"
        >
          Download Again
        </button>
      </div>

      <div class="stats-row">
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.metadata.stats.highwaysCount }}</span>
          <span class="stat-lbl">Roads</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.metadata.stats.buildingsCount }}</span>
          <span class="stat-lbl">Buildings</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.metadata.stats.relationsCount }}</span>
          <span class="stat-lbl">Relations</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOsmPayload.elements.length }}</span>
          <span class="stat-lbl">Total</span>
        </div>
      </div>
    </div>

    <!-- Overture Export Summary Card -->
    <div v-if="dataSource === 'overture' && lastOverturePayload" class="summary-box">
      <div class="summary-header">
        <span class="summary-title">Overture Cache Ready</span>
        <button
          type="button"
          class="re-download-btn"
          @click="downloadOvertureGeoJson(lastOverturePayload!)"
        >
          Download Again
        </button>
      </div>

      <div class="stats-row">
        <div class="stat-pill">
          <span class="stat-num">{{ lastOverturePayload.metadata.counts.segment ?? 0 }}</span>
          <span class="stat-lbl">Roads</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOverturePayload.metadata.counts.building ?? 0 }}</span>
          <span class="stat-lbl">Buildings</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastOverturePayload.features.length }}</span>
          <span class="stat-lbl">Total Features</span>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal for > 10 km² -->
    <div v-if="showConfirmModal" class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-warn-icon">
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
          </div>
          <h4 class="modal-title">Confirm Large Query ({{ areaKm2.toFixed(2) }} km²)</h4>
        </div>
        <p class="modal-body">
          Your selected bounding box exceeds the recommended 10 km² threshold. Overpass API servers often rate-limit or terminate queries covering dense metropolitan zones of this size.
        </p>
        <div class="modal-actions">
          <button type="button" class="btn-cancel" @click="showConfirmModal = false">
            Cancel & Resize
          </button>
          <button type="button" class="btn-confirm-danger" @click="executeAction(pendingAction)">
            Proceed Anyway
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-controls-card {
  background: rgba(18, 22, 28, 0.94);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
  color: #f1f5f9;
  font-family: inherit;
}

.source-toggle-row {
  display: flex;
  gap: 6px;
  background: rgba(0, 0, 0, 0.25);
  padding: 3px;
  border-radius: 8px;
  margin-bottom: 12px;
}

.source-tab-btn {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-tab-btn:hover {
  color: #f8fafc;
}

.source-tab-btn.active {
  background: #3b82f6;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.4);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.header-text-block {
  flex: 1;
}

.godot-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 9999px;
  background: rgba(100, 116, 139, 0.2);
  border: 1px solid rgba(148, 163, 184, 0.25);
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
}

.godot-badge.is-connected {
  background: rgba(34, 197, 94, 0.15);
  border-color: rgba(34, 197, 94, 0.4);
  color: #4ade80;
}

.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
}

.godot-badge.is-connected .badge-dot {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.8);
}

.header-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(37, 99, 235, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-icon {
  width: 18px;
  height: 18px;
  color: #60a5fa;
}

.card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.card-sub {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: #94a3b8;
}

.fallback-toggle {
  margin-bottom: 12px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.toggle-text {
  font-size: 11.5px;
  color: #94a3b8;
}

.actions-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.primary-godot-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #0284c7;
  color: #ffffff;
  border: 1px solid #38bdf8;
  border-radius: 8px;
  height: 40px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
}

.primary-godot-btn.is-linked {
  background: #16a34a;
  border-color: #4ade80;
  box-shadow: 0 4px 14px rgba(22, 163, 74, 0.35);
}

.primary-godot-btn:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.primary-godot-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.secondary-export-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  height: 32px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.secondary-export-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.secondary-export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-icon-sub {
  width: 14px;
  height: 14px;
  opacity: 0.8;
}

.transfer-success-box {
  margin-top: 4px;
  margin-bottom: 8px;
  padding: 8px 10px;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 6px;
}

.transfer-badge {
  font-size: 11.5px;
  font-weight: 700;
  color: #4ade80;
  margin-bottom: 2px;
}

.transfer-detail {
  font-size: 11px;
  color: #bbf7d0;
  line-height: 1.4;
}

.transfer-error-box {
  margin-top: 4px;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 6px;
  font-size: 11.5px;
  color: #fca5a5;
}

.transfer-err-label {
  font-weight: 600;
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.btn-spinner {
  width: 15px;
  height: 15px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.status-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.12);
  border: 1px solid rgba(59, 130, 246, 0.25);
  font-size: 12px;
  color: #bfdbfe;
  margin-top: 8px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #60a5fa;
  flex-shrink: 0;
}

.status-dot.is-pulse {
  animation: pulse 1s infinite alternate;
}

@keyframes pulse {
  from {
    opacity: 0.4;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1.15);
  }
}

.error-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.14);
  border: 1px solid rgba(239, 68, 68, 0.35);
  font-size: 12px;
  color: #fca5a5;
  margin-top: 8px;
  line-height: 1.35;
}

.error-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-top: 1px;
}

.summary-box {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 8px;
}

.summary-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.summary-title {
  font-size: 12px;
  font-weight: 700;
  color: #6ee7b7;
}

.re-download-btn {
  background: none;
  border: none;
  color: #a7f3d0;
  font-size: 11px;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.stat-pill {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-num {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
  font-family: 'JetBrains Mono', monospace;
}

.stat-lbl {
  font-size: 9.5px;
  color: #94a3b8;
  text-transform: uppercase;
}

/* Confirmation Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  padding: 16px;
}

.modal-card {
  background: #181d24;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  max-width: 440px;
  width: 100%;
  padding: 20px;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.6);
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.modal-warn-icon {
  width: 24px;
  height: 24px;
  color: #f87171;
  flex-shrink: 0;
}

.modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #fee2e2;
}

.modal-body {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.45;
  color: #cbd5e1;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn-cancel {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f1f5f9;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.btn-confirm-danger {
  background: #dc2626;
  border: 1px solid #ef4444;
  color: #ffffff;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
</style>
