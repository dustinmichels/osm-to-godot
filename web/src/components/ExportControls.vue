<script setup lang="ts">
import { ref } from 'vue'
import { useBBox } from '@/composables/useBBox'
import { useOverpass } from '@/composables/useOverpass'

const { hasBBox, isDangerSize, areaKm2 } = useBBox()
const {
  isLoading,
  statusMessage,
  errorMessage,
  lastExportPayload,
  executeExport,
  downloadJsonFile
} = useOverpass()

const showConfirmModal = ref(false)
const forceFallback = ref(false)

function onExportClick() {
  if (!hasBBox.value) return

  if (isDangerSize.value) {
    showConfirmModal.value = true
    return
  }

  handleExecute()
}

async function handleExecute() {
  showConfirmModal.value = false
  const payload = await executeExport({ forceFallback: forceFallback.value })
  if (payload) {
    downloadJsonFile(payload)
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
      <div>
        <h3 class="card-title">Godot 3D Export</h3>
        <p class="card-sub">Extract road ribbons & 3D buildings</p>
      </div>
    </div>

    <!-- Fallback Switch -->
    <div class="fallback-toggle">
      <label class="toggle-label">
        <input v-model="forceFallback" type="checkbox" :disabled="isLoading" />
        <span class="toggle-text">Use OSM 0.6 API directly (fast for tiny boxes)</span>
      </label>
    </div>

    <!-- Action Button -->
    <div class="actions-row">
      <button
        type="button"
        class="primary-export-btn"
        :class="{ 'is-loading': isLoading }"
        :disabled="!hasBBox || isLoading"
        @click="onExportClick"
      >
        <span v-if="isLoading" class="btn-spinner" />
        <svg v-else viewBox="0 0 20 20" fill="currentColor" class="btn-icon">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
        <span>{{ isLoading ? 'Extracting Data...' : 'Export osm_export.json' }}</span>
      </button>
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
    <div v-if="lastExportPayload" class="summary-box">
      <div class="summary-header">
        <span class="summary-title">Export Succeeded</span>
        <button
          type="button"
          class="re-download-btn"
          @click="downloadJsonFile(lastExportPayload)"
        >
          Download Again
        </button>
      </div>

      <div class="stats-row">
        <div class="stat-pill">
          <span class="stat-num">{{ lastExportPayload.metadata.stats.highwaysCount }}</span>
          <span class="stat-lbl">Roads</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastExportPayload.metadata.stats.buildingsCount }}</span>
          <span class="stat-lbl">Buildings</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastExportPayload.metadata.stats.relationsCount }}</span>
          <span class="stat-lbl">Relations</span>
        </div>
        <div class="stat-pill">
          <span class="stat-num">{{ lastExportPayload.elements.length }}</span>
          <span class="stat-lbl">Total</span>
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
          <button type="button" class="btn-confirm-danger" @click="handleExecute">
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

.card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
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
  margin-bottom: 10px;
}

.primary-export-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #2563eb;
  color: #ffffff;
  border: 1px solid #3b82f6;
  border-radius: 8px;
  height: 40px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
}

.primary-export-btn:hover:not(:disabled) {
  background: #1d4ed8;
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(37, 99, 235, 0.45);
}

.primary-export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
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
