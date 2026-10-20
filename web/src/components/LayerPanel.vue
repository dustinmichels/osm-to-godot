<script setup lang="ts">
import { computed } from 'vue'
import { useEditorModel } from '@/composables/useEditorModel'
import { deriveJunctionFeatures } from '@/composables/editor/junctionTopology'
const {
  project,
  selectedFeatureId,
  selectFeature,
  activeSource,
  isLayerVisible,
  toggleLayerVisibility,
  getCategoryExplanation,
  isExportIncluded,
  toggleExportInclusion,
  setExportInclusion,
  exportSummary,
  resetExportInclusions,
  junctionGraph
} = useEditorModel()

const roads = computed(() =>
  project.value.features.filter((f) => {
    const k = (f.kind || f.role) as string
    return k === 'road' || k === 'carriageway'
  })
)
const buildings = computed(() => project.value.features.filter((f) => ((f.kind || f.role) as string) === 'building'))
const sidewalks = computed(() =>
  project.value.features.filter((f) => {
    const k = (f.kind || f.role) as string
    return k === 'sidewalk' || k === 'footway'
  })
)
const bikeLanes = computed(() =>
  project.value.features.filter((f) => {
    const k = (f.kind || f.role) as string
    return k === 'bike_lane' || k === 'bike_facility' || k === 'cycleway'
  })
)
const totalCyclingCount = computed(() =>
  project.value.features.filter((f) => {
    const k = (f.kind || f.role) as string
    return (
      k === 'bike_lane' ||
      k === 'bike_facility' ||
      k === 'cycleway' ||
      f.roadProfile?.strips?.some((s) => s.kind === 'bike_lane' || s.kind === 'cycleway')
    )
  }).length
)
const junctions = computed(() => {
  const fromFeatures = project.value.features.filter((f) => ((f.kind || f.role) as string) === 'junction')
  if (fromFeatures.length > 0) return fromFeatures
  return deriveJunctionFeatures(junctionGraph.value, project.value.projectionOrigin)
})
const unsupportedFeatures = computed(() =>
  project.value.features.filter((f) => {
    const k = (f.kind || f.role) as string
    return (
      k === 'unsupported' ||
      (k !== 'road' &&
        k !== 'carriageway' &&
        k !== 'building' &&
        k !== 'sidewalk' &&
        k !== 'footway' &&
        k !== 'bike_lane' &&
        k !== 'bike_facility' &&
        k !== 'cycleway' &&
        k !== 'junction')
    )
  })
)
</script>

<template>
  <div class="layer-panel" data-testid="layer-panel">
    <div class="panel-header">
      <div class="panel-title-wrap">
        <h3 class="panel-title">Layers &amp; Features</h3>
        <span class="source-tag" :data-source="activeSource">{{ activeSource === 'osm' ? 'OSM' : activeSource === 'overture' ? 'Overture' : 'Custom' }}</span>
      </div>
      <span class="panel-badge">{{ project.features.length }}</span>
    </div>

    <!-- Road / Carriageway Layers -->
    <div class="layer-group" :class="{ 'layer-hidden': !isLayerVisible('carriageway'), 'layer-unavailable': roads.length === 0 }">
      <div class="group-title">
        <div class="group-title-left">
          <span class="group-dot road-dot" />
          <span>Carriageways ({{ roads.length }})</span>
          <span v-if="roads.length === 0" class="badge-unavailable">0 Features</span>
        </div>
        <div class="group-title-actions">
          <label
            class="export-toggle-label"
            :class="{ 'is-excluded': !isExportIncluded('carriageway'), 'is-disabled': roads.length === 0 }"
            :title="roads.length === 0 ? 'No carriageways present in source data' : (isExportIncluded('carriageway') ? 'Include Carriageways in Godot export' : 'Exclude Carriageways from Godot export')"
          >
            <input
              type="checkbox"
              :checked="isExportIncluded('carriageway')"
              :disabled="roads.length === 0"
              data-testid="toggle-export-carriageway"
              data-testid-road="toggle-export-road"
              @change="toggleExportInclusion('carriageway')"
            />
            <span class="export-toggle-badge">Export</span>
          </label>
          <button
            type="button"
            class="visibility-toggle-btn"
            :class="{ 'is-hidden': !isLayerVisible('carriageway'), 'is-disabled': roads.length === 0 }"
            :disabled="roads.length === 0"
            :title="roads.length === 0 ? 'No carriageways present in source data' : (isLayerVisible('carriageway') ? 'Hide Carriageways in map display' : 'Show Carriageways in map display')"
            data-testid="toggle-visibility-road"
            data-testid-carriageway="toggle-visibility-carriageway"
            @click.stop="toggleLayerVisibility('carriageway')"
          >
            <svg v-if="isLayerVisible('road')" viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="!isLayerVisible('carriageway')" class="layer-hidden-notice">
        Hidden from map display (profile preserved)
      </div>
      <div v-if="!isExportIncluded('carriageway')" class="layer-excluded-notice" data-testid="notice-export-excluded-carriageway">
        Excluded from Godot export
      </div>
      <div v-if="roads.length === 0" class="unavailable-hint" data-testid="unavailable-carriageway">
        {{ getCategoryExplanation('carriageway') }}
      </div>
      <div v-else class="feature-list">
        <button
          v-for="road in roads"
          :key="road.id"
          type="button"
          class="feature-item"
          :class="{ selected: road.id === selectedFeatureId }"
          :aria-selected="road.id === selectedFeatureId"
          :aria-label="`Select road ${road.properties?.name || road.properties?.class || road.sourceId}`"
          @click="selectFeature(road.id)"
        >
          <span class="feature-name">
            {{ road.properties?.name || road.properties?.class || road.sourceId }}
          </span>
          <span v-if="road.inferred?.width" class="badge-inferred-pill" title="Width inferred">
            inferred
          </span>
        </button>
      </div>
    </div>

    <!-- Building Layers -->
    <div class="layer-group" :class="{ 'layer-hidden': !isLayerVisible('building'), 'layer-unavailable': buildings.length === 0 }">
      <div class="group-title">
        <div class="group-title-left">
          <span class="group-dot building-dot" />
          <span>Buildings ({{ buildings.length }})</span>
          <span v-if="buildings.length === 0" class="badge-unavailable">0 Features</span>
        </div>
        <div class="group-title-actions">
          <label
            class="export-toggle-label"
            :class="{ 'is-excluded': !isExportIncluded('building'), 'is-disabled': buildings.length === 0 }"
            :title="buildings.length === 0 ? 'No buildings present in source data' : (isExportIncluded('building') ? 'Include Buildings in Godot export' : 'Exclude Buildings from Godot export')"
          >
            <input
              type="checkbox"
              :checked="isExportIncluded('building')"
              :disabled="buildings.length === 0"
              data-testid="toggle-export-building"
              @change="toggleExportInclusion('building')"
            />
            <span class="export-toggle-badge">Export</span>
          </label>
          <button
            type="button"
            class="visibility-toggle-btn"
            :class="{ 'is-hidden': !isLayerVisible('building'), 'is-disabled': buildings.length === 0 }"
            :disabled="buildings.length === 0"
            :title="buildings.length === 0 ? 'No buildings present in source data' : (isLayerVisible('building') ? 'Hide Buildings in map display' : 'Show Buildings in map display')"
            data-testid="toggle-visibility-building"
            @click.stop="toggleLayerVisibility('building')"
          >
            <svg v-if="isLayerVisible('building')" viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="!isLayerVisible('building')" class="layer-hidden-notice">
        Hidden from map display (profile preserved)
      </div>
      <div v-if="!isExportIncluded('building')" class="layer-excluded-notice" data-testid="notice-export-excluded-building">
        Excluded from Godot export
      </div>
      <div v-if="buildings.length === 0" class="unavailable-hint" data-testid="unavailable-building">
        {{ getCategoryExplanation('building') }}
      </div>
      <div v-else class="feature-list">
        <button
          v-for="bldg in buildings"
          :key="bldg.id"
          type="button"
          class="feature-item"
          :class="{ selected: bldg.id === selectedFeatureId }"
          :aria-selected="bldg.id === selectedFeatureId"
          :aria-label="`Select building ${bldg.properties?.name || bldg.sourceId}`"
          @click="selectFeature(bldg.id)"
        >
          <span class="feature-name">
            {{ bldg.properties?.name || bldg.sourceId }}
          </span>
          <span v-if="bldg.buildingProfile?.heightMeters?.value" class="feature-sub">
            {{ bldg.buildingProfile.heightMeters.value }}m
          </span>
        </button>
      </div>
    </div>

    <!-- Sidewalk Layers -->
    <div class="layer-group" :class="{ 'layer-hidden': !isLayerVisible('sidewalk'), 'layer-unavailable': sidewalks.length === 0 }">
      <div class="group-title">
        <div class="group-title-left">
          <span class="group-dot sidewalk-dot" />
          <span>Sidewalks ({{ sidewalks.length }})</span>
          <span v-if="sidewalks.length === 0" class="badge-unavailable">0 Features</span>
        </div>
        <div class="group-title-actions">
          <label
            class="export-toggle-label"
            :class="{ 'is-excluded': !isExportIncluded('sidewalk'), 'is-disabled': sidewalks.length === 0 }"
            :title="sidewalks.length === 0 ? 'No sidewalks present in source data' : (isExportIncluded('sidewalk') ? 'Include Sidewalks in Godot export' : 'Exclude Sidewalks from Godot export')"
          >
            <input
              type="checkbox"
              :checked="isExportIncluded('sidewalk')"
              :disabled="sidewalks.length === 0"
              data-testid="toggle-export-sidewalk"
              @change="toggleExportInclusion('sidewalk')"
            />
            <span class="export-toggle-badge">Export</span>
          </label>
          <button
            type="button"
            class="visibility-toggle-btn"
            :class="{ 'is-hidden': !isLayerVisible('sidewalk'), 'is-disabled': sidewalks.length === 0 }"
            :disabled="sidewalks.length === 0"
            :title="sidewalks.length === 0 ? 'No sidewalks present in source data' : (isLayerVisible('sidewalk') ? 'Hide Sidewalks in map display' : 'Show Sidewalks in map display')"
            data-testid="toggle-visibility-sidewalk"
            @click.stop="toggleLayerVisibility('sidewalk')"
          >
            <svg v-if="isLayerVisible('sidewalk')" viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="!isLayerVisible('sidewalk')" class="layer-hidden-notice">
        Hidden from map display (presence &amp; road width preserved)
      </div>
      <div v-if="!isExportIncluded('sidewalk')" class="layer-excluded-notice" data-testid="notice-export-excluded-sidewalk">
        Excluded from Godot export (profile preserved)
      </div>
      <div v-if="sidewalks.length === 0" class="unavailable-hint" data-testid="unavailable-sidewalk">
        {{ getCategoryExplanation('sidewalk') }}
      </div>
      <div v-else class="feature-list">
        <button
          v-for="sw in sidewalks"
          :key="sw.id"
          type="button"
          class="feature-item"
          :class="{ selected: sw.id === selectedFeatureId }"
          :aria-selected="sw.id === selectedFeatureId"
          :aria-label="`Select sidewalk ${sw.properties?.name || sw.sourceId}`"
          @click="selectFeature(sw.id)"
        >
          <span class="feature-name">{{ sw.properties?.name || sw.sourceId }}</span>
        </button>
      </div>
    </div>

    <!-- Cycling Infrastructure (Top-Level Cycling Toggle + Standalone / On-Road Distinction) -->
    <div
      class="layer-group"
      :class="{ 'layer-hidden': !isLayerVisible('cycling'), 'layer-unavailable': totalCyclingCount === 0 }"
      data-testid="layer-group-cycling"
    >
      <div class="group-title">
        <div class="group-title-left">
          <span class="group-dot bike-dot" />
          <span>Cycling Infrastructure ({{ totalCyclingCount }})</span>
          <span v-if="totalCyclingCount === 0" class="badge-unavailable">0 Features</span>
        </div>
        <div class="group-title-actions">
          <label
            class="export-toggle-label"
            :class="{ 'is-excluded': !isExportIncluded('cycling'), 'is-disabled': totalCyclingCount === 0 }"
            :title="totalCyclingCount === 0 ? 'No cycling facilities present in source data' : (isExportIncluded('cycling') ? 'Include Cycling Infrastructure in Godot export' : 'Exclude Cycling Infrastructure from Godot export')"
          >
            <input
              type="checkbox"
              :checked="isExportIncluded('cycling')"
              :disabled="totalCyclingCount === 0"
              data-testid="toggle-export-cycling"
              @change="toggleExportInclusion('cycling')"
            />
            <span class="export-toggle-badge">Export</span>
          </label>
          <button
            type="button"
            class="visibility-toggle-btn"
            :class="{ 'is-hidden': !isLayerVisible('cycling'), 'is-disabled': totalCyclingCount === 0 }"
            :disabled="totalCyclingCount === 0"
            :title="totalCyclingCount === 0 ? 'No cycling infrastructure present in source data' : (isLayerVisible('cycling') ? 'Hide Cycling Infrastructure in map display' : 'Show Cycling Infrastructure in map display')"
            data-testid="toggle-visibility-cycling"
            data-testid-bike-lane="toggle-visibility-bike_lane"
            @click.stop="toggleLayerVisibility('cycling')"
          >
            <svg v-if="isLayerVisible('cycling')" viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="!isLayerVisible('cycling')" class="layer-hidden-notice">
        Hidden from map display (cycling infrastructure preserved)
      </div>
      <div v-if="!isExportIncluded('cycling')" class="layer-excluded-notice" data-testid="notice-export-excluded-cycling">
        Excluded from Godot export
      </div>
      <div v-if="totalCyclingCount === 0" class="unavailable-hint" data-testid="unavailable-cycling">
        {{ getCategoryExplanation('cycling') }}
      </div>
      <div v-else class="cycling-sub-controls">
        <div class="cycling-sub-row">
          <label class="cycling-sub-label" :class="{ 'is-disabled': !isLayerVisible('cycling') }">
            <input
              type="checkbox"
              :checked="isLayerVisible('bike_lane')"
              :disabled="!isLayerVisible('cycling')"
              data-testid="toggle-visibility-bike_lane"
              data-testid-sub="toggle-sub-bike_lane"
              @change="toggleLayerVisibility('bike_lane')"
            />
            <span class="sub-swatch bike-swatch"></span>
            <span>On-Road Lanes</span>
          </label>
          <label class="sub-export-toggle-label" :class="{ 'is-disabled': !isExportIncluded('cycling') }">
            <input
              type="checkbox"
              :checked="isExportIncluded('bike_lane')"
              :disabled="!isExportIncluded('cycling')"
              data-testid="toggle-export-bike_lane"
              @change="toggleExportInclusion('bike_lane')"
            />
            <span class="sub-export-text">Export</span>
          </label>
        </div>
        <div class="cycling-sub-row">
          <label class="cycling-sub-label" :class="{ 'is-disabled': !isLayerVisible('cycling') }">
            <input
              type="checkbox"
              :checked="isLayerVisible('cycleway')"
              :disabled="!isLayerVisible('cycling')"
              data-testid="toggle-visibility-cycleway"
              data-testid-sub="toggle-sub-cycleway"
              @change="toggleLayerVisibility('cycleway')"
            />
            <span class="sub-swatch cycleway-swatch"></span>
            <span>Standalone Cycleways</span>
          </label>
          <label class="sub-export-toggle-label" :class="{ 'is-disabled': !isExportIncluded('cycling') }">
            <input
              type="checkbox"
              :checked="isExportIncluded('cycleway')"
              :disabled="!isExportIncluded('cycling')"
              data-testid="toggle-export-cycleway"
              @change="toggleExportInclusion('cycleway')"
            />
            <span class="sub-export-text">Export</span>
          </label>
        </div>
      </div>
      <div v-if="totalCyclingCount > 0" class="feature-list">
        <button
          v-for="b in bikeLanes"
          :key="b.id"
          type="button"
          class="feature-item"
          :class="{ selected: b.id === selectedFeatureId }"
          :aria-selected="b.id === selectedFeatureId"
          :aria-label="`Select ${b.kind === 'bike_facility' || b.properties?.highway === 'cycleway' ? 'cycleway' : 'bike lane'} ${b.properties?.name || b.sourceId}`"
          @click="selectFeature(b.id)"
        >
          <span class="feature-name">{{ b.properties?.name || b.sourceId }}</span>
          <span
            class="facility-badge"
            :class="b.kind === 'bike_facility' || b.properties?.highway === 'cycleway' ? 'badge-cycleway' : 'badge-bikelane'"
          >
            {{ b.kind === 'bike_facility' || b.properties?.highway === 'cycleway' ? 'Cycleway' : 'Bike Lane' }}
          </span>
        </button>
      </div>
    </div>
    <!-- Junction Layers -->
    <div class="layer-group" :class="{ 'layer-hidden': !isLayerVisible('junction'), 'layer-unavailable': junctions.length === 0 }">
      <div class="group-title">
        <div class="group-title-left">
          <span class="group-dot junction-dot" />
          <span>Junctions ({{ junctions.length }})</span>
          <span v-if="junctions.length === 0" class="badge-unavailable">0 Features</span>
        </div>
        <div class="group-title-actions">
          <label
            class="export-toggle-label"
            :class="{ 'is-excluded': !isExportIncluded('junction'), 'is-disabled': junctions.length === 0 }"
            :title="junctions.length === 0 ? 'No junctions present in source data' : (isExportIncluded('junction') ? 'Include Junctions in Godot export' : 'Exclude Junctions from Godot export')"
          >
            <input
              type="checkbox"
              :checked="isExportIncluded('junction')"
              :disabled="junctions.length === 0"
              data-testid="toggle-export-junction"
              @change="toggleExportInclusion('junction')"
            />
            <span class="export-toggle-badge">Export</span>
          </label>
          <button
            type="button"
            class="visibility-toggle-btn"
            :class="{ 'is-hidden': !isLayerVisible('junction'), 'is-disabled': junctions.length === 0 }"
            :disabled="junctions.length === 0"
            :title="junctions.length === 0 ? 'No junctions present in source data' : (isLayerVisible('junction') ? 'Hide Junctions in map display' : 'Show Junctions in map display')"
            data-testid="toggle-visibility-junction"
            @click.stop="toggleLayerVisibility('junction')"
          >
            <svg v-if="isLayerVisible('junction')" viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="!isLayerVisible('junction')" class="layer-hidden-notice">
        Hidden from map display
      </div>
      <div v-if="!isExportIncluded('junction')" class="layer-excluded-notice" data-testid="notice-export-excluded-junction">
        Excluded from Godot export
      </div>
      <div v-if="junctions.length === 0" class="unavailable-hint" data-testid="unavailable-junction">
        {{ getCategoryExplanation('junction') }}
      </div>
      <div v-else class="feature-list">
        <button
          v-for="j in junctions"
          :key="j.id"
          type="button"
          class="feature-item"
          :class="{ selected: j.id === selectedFeatureId }"
          :aria-selected="j.id === selectedFeatureId"
          :aria-label="`Select junction ${j.sourceId}`"
          @click="selectFeature(j.id)"
        >
          <span class="feature-name">{{ j.sourceId }}</span>
        </button>
      </div>
    </div>

    <!-- Unsupported Features (Preserved for Round-Tripping) -->
    <div class="layer-group unsupported-group" :class="{ 'layer-hidden': !isLayerVisible('unsupported'), 'layer-unavailable': unsupportedFeatures.length === 0 }" data-testid="unsupported-features-group">
      <div class="group-title">
        <div class="group-title-left">
          <span class="group-dot unsupported-dot" />
          <span>Unsupported ({{ unsupportedFeatures.length }})</span>
          <span v-if="unsupportedFeatures.length === 0" class="badge-unavailable">0 Features</span>
        </div>
        <div class="group-title-actions">
          <label
            class="export-toggle-label"
            :class="{ 'is-excluded': !isExportIncluded('unsupported'), 'is-disabled': unsupportedFeatures.length === 0 }"
            :title="unsupportedFeatures.length === 0 ? 'No unsupported features present in source data' : (isExportIncluded('unsupported') ? 'Include Unsupported in Godot export' : 'Exclude Unsupported from Godot export')"
          >
            <input
              type="checkbox"
              :checked="isExportIncluded('unsupported')"
              :disabled="unsupportedFeatures.length === 0"
              data-testid="toggle-export-unsupported"
              @change="toggleExportInclusion('unsupported')"
            />
            <span class="export-toggle-badge">Export</span>
          </label>
          <button
            type="button"
            class="visibility-toggle-btn"
            :class="{ 'is-hidden': !isLayerVisible('unsupported'), 'is-disabled': unsupportedFeatures.length === 0 }"
            :disabled="unsupportedFeatures.length === 0"
            :title="unsupportedFeatures.length === 0 ? 'No unsupported features present in source data' : (isLayerVisible('unsupported') ? 'Hide Unsupported in map display' : 'Show Unsupported in map display')"
            data-testid="toggle-visibility-unsupported"
            @click.stop="toggleLayerVisibility('unsupported')"
          >
            <svg v-if="isLayerVisible('unsupported')" viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
            </svg>
            <svg v-else viewBox="0 0 20 20" fill="currentColor" class="vis-icon">
              <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
              <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="!isLayerVisible('unsupported')" class="layer-hidden-notice">
        Hidden from map display (raw properties preserved)
      </div>
      <div v-if="!isExportIncluded('unsupported')" class="layer-excluded-notice" data-testid="notice-export-excluded-unsupported">
        Excluded from Godot export (retained in ProjectEnvelope)
      </div>
      <div v-if="unsupportedFeatures.length === 0" class="unavailable-hint" data-testid="unavailable-unsupported">
        {{ getCategoryExplanation('unsupported') }}
      </div>
      <div v-else class="unsupported-hint">
        Features that cannot be rendered or sent to Godot; raw properties preserved for inspection and project round-tripping.
      </div>
      <div v-if="unsupportedFeatures.length > 0" class="feature-list">
        <button
          v-for="item in unsupportedFeatures"
          :key="item.id"
          type="button"
          class="feature-item unsupported-item"
          :class="{ selected: item.id === selectedFeatureId }"
          :aria-selected="item.id === selectedFeatureId"
          :aria-label="`Select unsupported feature ${item.sourceId}`"
          :title="`Unsupported feature '${item.sourceId}': raw properties preserved`"
          @click="selectFeature(item.id)"
        >
          <span class="feature-name">{{ item.sourceId }}</span>
          <span class="badge-unsupported-pill">raw</span>
        </button>
      </div>
    </div>
    <!-- Subordinate Controls: Overlays & Display Guides -->
    <div class="subordinate-controls-section" data-testid="subordinate-controls-section">
      <div class="subordinate-header">Display Overlays &amp; Guides</div>
      <div class="subordinate-grid">
        <label class="subordinate-toggle" data-testid="subordinate-toggle-centerlines">
          <input
            type="checkbox"
            :checked="isLayerVisible('centerlines')"
            @change="toggleLayerVisibility('centerlines')"
          />
          <span class="subordinate-label">Centerlines</span>
        </label>
        <label class="subordinate-toggle" data-testid="subordinate-toggle-vertices">
          <input
            type="checkbox"
            :checked="isLayerVisible('vertices')"
            @change="toggleLayerVisibility('vertices')"
          />
          <span class="subordinate-label">Vertices</span>
        </label>
        <label class="subordinate-toggle" data-testid="subordinate-toggle-labels">
          <input
            type="checkbox"
            :checked="isLayerVisible('labels')"
            @change="toggleLayerVisibility('labels')"
          />
          <span class="subordinate-label">Labels</span>
        </label>
        <label class="subordinate-toggle" data-testid="subordinate-toggle-junctions">
          <input
            type="checkbox"
            :checked="isLayerVisible('junction_surfaces')"
            @change="toggleLayerVisibility('junction_surfaces')"
          />
          <span class="subordinate-label">Junction Surfaces</span>
        </label>
        <label class="subordinate-toggle" data-testid="subordinate-toggle-inferences">
          <input
            type="checkbox"
            :checked="isLayerVisible('inference_overlays')"
            @change="toggleLayerVisibility('inference_overlays')"
          />
          <span class="subordinate-label">Inference Overlays</span>
        </label>
        <label class="subordinate-toggle" data-testid="subordinate-toggle-warnings">
          <input
            type="checkbox"
            :checked="isLayerVisible('warning_overlays')"
            @change="toggleLayerVisibility('warning_overlays')"
          />
          <span class="subordinate-label">Warning Overlays</span>
        </label>
      </div>
    </div>

    <!-- Export Summary & Exclusions Section -->
    <div class="export-summary-section" data-testid="export-summary-section">
      <div class="export-summary-header">
        <div class="export-summary-title">
          <svg viewBox="0 0 20 20" fill="currentColor" class="godot-icon">
            <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" />
          </svg>
          <span>Godot Export Summary</span>
        </div>
        <span
          class="export-summary-badge"
          :class="exportSummary.hasExclusions ? 'badge-has-exclusions' : 'badge-all-included'"
          data-testid="export-summary-badge"
        >
          {{ exportSummary.hasExclusions ? `${exportSummary.exclusions.length} Excluded` : 'All Included' }}
        </span>
      </div>

      <!-- Exclusions List if any -->
      <div v-if="exportSummary.hasExclusions" class="export-exclusions-box" data-testid="export-exclusions-box">
        <div class="exclusions-warning-header">
          <span class="warn-icon">⚠️</span>
          <span>Excluding {{ exportSummary.excludedFeatureCount }} feature{{ exportSummary.excludedFeatureCount === 1 ? '' : 's' }} from Godot export:</span>
        </div>
        <ul class="exclusions-list" data-testid="export-exclusions-list">
          <li v-for="item in exportSummary.exclusions" :key="item.category" class="exclusion-item" :data-testid="`exclusion-item-${item.category}`">
            <div class="exclusion-item-info">
              <span class="exclusion-label">{{ item.label }}</span>
              <span class="exclusion-count">({{ item.count }} feature{{ item.count === 1 ? '' : 's' }})</span>
            </div>
            <button
              type="button"
              class="btn-reinclude"
              :data-testid="`btn-reinclude-${item.category}`"
              title="Re-include this category in Godot export"
              @click="setExportInclusion(item.category, true)"
            >
              Include
            </button>
          </li>
        </ul>
        <button
          type="button"
          class="btn-reset-inclusions"
          data-testid="btn-reset-export-inclusions"
          @click="() => resetExportInclusions()"
        >
          Include All Layers in Export
        </button>
      </div>

      <!-- All Included Notice -->
      <div v-else class="export-all-included-box" data-testid="export-all-included-box">
        <span class="check-icon">✓</span>
        <span>All active layers included in Godot export ({{ exportSummary.totalFeatureCount }} features)</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subordinate-controls-section {
  padding: 10px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.2);
}

.subordinate-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 8px;
}

.subordinate-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
}

.subordinate-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #cbd5e1;
  cursor: pointer;
}

.subordinate-toggle input[type="checkbox"] {
  cursor: pointer;
  accent-color: #38bdf8;
}

.subordinate-label {
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.layer-panel {
  background: rgba(13, 17, 23, 0.95);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  width: 260px;
  max-height: calc(100vh - 120px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e2e8f0;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.panel-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.panel-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-tag {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #94a3b8;
}

.source-tag[data-source="osm"] {
  background: rgba(59, 130, 246, 0.2);
  color: #93c5fd;
}

.source-tag[data-source="overture"] {
  background: rgba(234, 179, 8, 0.2);
  color: #fde047;
}


.panel-badge {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 10px;
  color: #94a3b8;
}

.layer-group {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  margin-bottom: 6px;
}

.group-title-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.visibility-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  color: #94a3b8;
  transition: all 0.15s ease;
}

.visibility-toggle-btn:hover {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.08);
}

.visibility-toggle-btn:focus-visible {
  outline: 2px solid #38bdf8;
  outline-offset: 1px;
}

.visibility-toggle-btn.is-hidden {
  color: #64748b;
}

.vis-icon {
  width: 13px;
  height: 13px;
}

.layer-group.layer-hidden {
  opacity: 0.6;
}

.layer-hidden-notice {
  font-size: 10px;
  color: #94a3b8;
  font-style: italic;
  margin-bottom: 4px;
  padding-left: 2px;
}

.group-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.road-dot {
  background: #f59e0b;
}

.building-dot {
  background: #3b82f6;
}

.sidewalk-dot {
  background: #94a3b8;
}

.bike-dot {
  background: #10b981;
}
.cycling-sub-controls {
  display: flex;
  gap: 12px;
  padding: 4px 0 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  margin-bottom: 6px;
}

.cycling-sub-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #cbd5e1;
  cursor: pointer;
  user-select: none;
}

.cycling-sub-label.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sub-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
}

.sub-swatch.bike-swatch {
  background: #10b981;
}

.sub-swatch.cycleway-swatch {
  background: #059669;
  border: 1px dashed #34d399;
}

.facility-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 8px;
  margin-left: auto;
  font-weight: 500;
}

.badge-cycleway {
  background: rgba(5, 150, 105, 0.25);
  color: #34d399;
  border: 1px solid rgba(52, 211, 153, 0.3);
}

.badge-bikelane {
  background: rgba(16, 185, 129, 0.25);
  color: #6ee7b7;
  border: 1px solid rgba(110, 231, 183, 0.3);
}

.junction-dot {
  background: #a855f7;
}

.unsupported-dot {
  background: #ef4444;
}

.other-dot {
  background: #94a3b8;
}

.feature-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  max-height: 180px;
}

.feature-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  user-select: none;
  background: transparent;
  border: 1px solid transparent;
  color: inherit;
  text-align: left;
  width: 100%;
  font-family: inherit;
}

.feature-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.feature-item:focus-visible {
  outline: 2px solid #38bdf8;
  outline-offset: 1px;
}

.feature-item.selected {
  background: rgba(56, 189, 248, 0.2);
  border: 1px solid rgba(56, 189, 248, 0.4);
  color: #38bdf8;
}

.feature-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 170px;
}

.feature-sub {
  font-size: 11px;
  color: #64748b;
}

.badge-inferred-pill {
  font-size: 9.5px;
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
  padding: 1px 4px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: 600;
}

.empty-hint {
  font-size: 11px;
  color: #64748b;
  font-style: italic;
  padding: 4px;
}

.unsupported-hint {
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.3;
  margin-bottom: 6px;
  font-style: italic;
}

.badge-unsupported-pill {
  font-size: 9px;
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.4);
  padding: 1px 3px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
}

.unsupported-item {
  border-left: 2px solid rgba(239, 68, 68, 0.5);
}

.visibility-toggle-btn.is-disabled,
.visibility-toggle-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

.layer-unavailable {
  opacity: 0.85;
}

.badge-unavailable {
  font-size: 9px;
  background: rgba(148, 163, 184, 0.15);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.3);
  padding: 1px 4px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
  margin-left: 6px;
}

.unavailable-hint {
  font-size: 11px;
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.03);
  border-left: 2px solid rgba(148, 163, 184, 0.4);
  padding: 6px 8px;
  margin: 4px 0;
  border-radius: 0 4px 4px 0;
  line-height: 1.4;
  font-style: italic;
}

.group-title-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.export-toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  padding: 1px 5px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.export-toggle-label:hover {
  color: #e2e8f0;
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.08);
}

.export-toggle-label input[type="checkbox"] {
  cursor: pointer;
  width: 11px;
  height: 11px;
  margin: 0;
  accent-color: #10b981;
}

.export-toggle-label.is-excluded {
  color: #f87171;
  border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.1);
}

.export-toggle-label.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

.export-toggle-badge {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.layer-excluded-notice {
  font-size: 10px;
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.08);
  border-left: 2px solid #ef4444;
  padding: 3px 6px;
  margin: 3px 0;
  border-radius: 0 4px 4px 0;
  font-style: italic;
}

.cycling-sub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.sub-export-toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 9px;
  color: #94a3b8;
  cursor: pointer;
  user-select: none;
}

.sub-export-toggle-label input[type="checkbox"] {
  cursor: pointer;
  width: 10px;
  height: 10px;
  margin: 0;
  accent-color: #10b981;
}

.sub-export-toggle-label.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

.sub-export-text {
  font-size: 9px;
  text-transform: uppercase;
  font-weight: 600;
}

.export-summary-section {
  padding: 10px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(15, 23, 42, 0.4);
}

.export-summary-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.export-summary-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #cbd5e1;
}

.godot-icon {
  width: 14px;
  height: 14px;
  color: #38bdf8;
}

.export-summary-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 9999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.badge-all-included {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.badge-has-exclusions {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.35);
}

.export-all-included-box {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  background: rgba(16, 185, 129, 0.06);
  border: 1px dashed rgba(16, 185, 129, 0.25);
  border-radius: 6px;
  padding: 6px 8px;
  line-height: 1.3;
}

.check-icon {
  color: #10b981;
  font-weight: bold;
}

.export-exclusions-box {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 6px;
  padding: 8px 10px;
}

.exclusions-warning-header {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #fbbf24;
  margin-bottom: 6px;
  line-height: 1.3;
}

.warn-icon {
  flex-shrink: 0;
}

.exclusions-list {
  list-style: none;
  margin: 0 0 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.exclusion-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  background: rgba(0, 0, 0, 0.25);
  padding: 3px 6px;
  border-radius: 4px;
  border-left: 2px solid #f59e0b;
}

.exclusion-item-info {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #e2e8f0;
}

.exclusion-count {
  color: #94a3b8;
  font-size: 10px;
}

.btn-reinclude {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(16, 185, 129, 0.2);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #34d399;
  cursor: pointer;
  text-transform: uppercase;
  transition: background 0.15s ease;
}

.btn-reinclude:hover {
  background: rgba(16, 185, 129, 0.35);
}

.btn-reset-inclusions {
  width: 100%;
  font-size: 10px;
  font-weight: 600;
  padding: 5px 8px;
  border-radius: 4px;
  background: rgba(56, 189, 248, 0.15);
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: #38bdf8;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  transition: all 0.15s ease;
}

.btn-reset-inclusions:hover {
  background: rgba(56, 189, 248, 0.25);
  border-color: rgba(56, 189, 248, 0.5);
}
</style>
