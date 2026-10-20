import { ref, computed, shallowRef } from 'vue'
import {
  ViewMode,
  ProjectEnvelope,
  EditorFeature,
  FeatureEditOverride,
  ViewSurface,
  CrossSectionStrip,
  DEFAULT_LAYER_VISIBILITY,
  DEFAULT_EXPORT_INCLUSIONS,
  mapKindToCategory,
  CategoryAvailability,
  ExportSummary,
  ExportExclusionItem,
  FacilityInferencePolicy,
  ExportClippingPolicy,
  RecomputationStats,
  FacilityPresence,
  CURRENT_PROJECT_SCHEMA_VERSION,
  CURRENT_EDITOR_PAYLOAD_VERSION,
  EditorGodotPayload,
  EditorExportFeature,
  EditorExportMetadata,
  FeatureRole,
  Provenance,
  BlockingGeometryError,
  SceneExportPreflight,
  SceneExportPreflightCounts,
  SceneExportPreflightExclusions
} from './editor/types'
import {
  findFeatureBlockingGeometryErrors,
  findProjectBlockingGeometryErrors
} from './editor/geometryWarnings'
import type { JunctionTopologyGraph } from './editor/types'
import { buildJunctionTopology, deriveJunctionFeatures } from './editor/junctionTopology'
import {
  DEFAULT_EXPORT_CLIPPING_POLICY,
  applyExportClippingToSurfaces,
  applyExportClippingToEnvelope
} from './editor/exportClipping'
import {
  generateViewSurfaces,
  generateSubordinateSurfaces,
  generateSurfacesForFeature,
  generateSubordinateSurfacesForFeature,
  computeDrawOrder,
  getFeatureEffectiveLayer,
  areFeaturesGradeSeparated,
  canJoinAtCrossing,
  doFeaturesIntersect2D
} from './editor/viewSurfaces'
export {
  computeDrawOrder,
  getFeatureEffectiveLayer,
  areFeaturesGradeSeparated,
  canJoinAtCrossing,
  doFeaturesIntersect2D,
  CATEGORY_DRAW_RANKS
} from './editor/viewSurfaces'
import {
  validateImportPayload,
  validateGeometryStructure,
  validatePositiveWidth,
  validateBuildingLevels,
  validateBuildingHeight,
  validateStripTotals,
  validateRoadLanes,
  validateRoadSpeedLimit,
  validateRoadProperties,
  validateEditorGodotPayload,
  ImportValidationResult,
  EditValidationResult
} from './editor/validation'
import { cloneFeature, cloneFeatureCollection, cloneProjectEnvelope } from './editor/featureCloning'
import {
  recalculateRoadStrips,
  extractOsmSidewalkSourceEvidence,
  extractOsmCycleSourceEvidence,
  extractOvertureSidewalkSourceEvidence,
  extractOvertureCycleSourceEvidence,
  buildRoadCrossSectionStrips
} from './editor/normalization'
import { associateSeparateFacilities } from './editor/facilityAssociation'
import { resolveFacilityInference } from './editor/roadProfiles'
import {
  createGeometryCache,
  populateGeometryCache,
  recomputeAffectedGeometry as recomputeAffectedGeometryImpl,
  flattenGeometryCache,
  flattenSubordinateSurfaces
} from './editor/incrementalGeometry'
import { getEditorWorkerBridge } from './editor/editorWorkerBridge'
const defaultProject: ProjectEnvelope = {
  schemaVersion: '1.0.0',
  sourceMetadata: {
    source: 'custom'
  },
  selectedBounds: undefined,
  projectionOrigin: {
    lon: 0,
    lat: 0
  },
  sourceFeatures: [],
  features: [],
  editOverrides: {},
  editorSettings: {
    viewMode: 'data',
    units: 'metric',
    showInferredBadges: true,
    facilityInferencePolicy: 'none',
    layerVisibility: { ...DEFAULT_LAYER_VISIBILITY },
    exportInclusions: { ...DEFAULT_EXPORT_INCLUSIONS }
  }
}

const project = ref<ProjectEnvelope>(defaultProject)
const viewMode = ref<ViewMode>('data')
const facilityInferencePolicy = ref<FacilityInferencePolicy>('none')
const selectedFeatureId = ref<string | null>(null)
const selectedStripId = ref<string | null>(null)
const selectedSurfaceId = ref<string | null>(null)
const hoveredFeatureId = ref<string | null>(null)
const hoveredSurfaceId = ref<string | null>(null)
const isDirty = ref<boolean>(false)
const lastImportValidation = ref<ImportValidationResult | null>(null)
const lastImportError = ref<string | null>(null)
const actionableImportAdvice = ref<string | null>(null)
const isImporting = ref<boolean>(false)
const importProgress = ref<{ stage: string; percent: number } | null>(null)
const isGeneratingGeometry = ref<boolean>(false)
let activeGeometryGenerationId = 0
const layerVisibility = ref<Record<string, boolean>>({ ...DEFAULT_LAYER_VISIBILITY })
const exportInclusions = ref<Record<string, boolean>>({ ...DEFAULT_EXPORT_INCLUSIONS })
const exportClippingPolicy = ref<ExportClippingPolicy>({ ...DEFAULT_EXPORT_CLIPPING_POLICY })

export interface EditOptions {
  continuous?: boolean
  groupKey?: string
}

interface HistorySnapshot {
  features: EditorFeature[]
  editOverrides: Record<string, FeatureEditOverride>
  exportInclusions?: Record<string, boolean>
  groupKey?: string
  version?: number
}

let currentVersion = 0
let savedVersion = 0

interface ContinuousAdjustmentState {
  isActive: boolean
  groupKey: string | null
  snapshotRecorded: boolean
  lastTimestamp: number
}

const continuousState = ref<ContinuousAdjustmentState>({
  isActive: false,
  groupKey: null,
  snapshotRecorded: false,
  lastTimestamp: 0
})

const isContinuousAdjustmentActive = computed(() => continuousState.value.isActive)

function beginContinuousAdjustment(groupKey?: string): void {
  continuousState.value = {
    isActive: true,
    groupKey: groupKey || 'continuous',
    snapshotRecorded: false,
    lastTimestamp: Date.now()
  }
}

function endContinuousAdjustment(): void {
  continuousState.value = {
    isActive: false,
    groupKey: null,
    snapshotRecorded: false,
    lastTimestamp: 0
  }
}

const undoStack = ref<HistorySnapshot[]>([])
const redoStack = ref<HistorySnapshot[]>([])
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)

function recordSnapshot(options?: EditOptions) {
  const isContinuous = Boolean(options?.continuous || continuousState.value.isActive)
  const groupKey = options?.groupKey || continuousState.value.groupKey || 'continuous'
  const now = Date.now()

  if (isContinuous) {
    if (
      continuousState.value.isActive &&
      continuousState.value.groupKey === groupKey &&
      continuousState.value.snapshotRecorded
    ) {
      continuousState.value.lastTimestamp = now
      return
    }
    continuousState.value = {
      isActive: true,
      groupKey,
      snapshotRecorded: true,
      lastTimestamp: now
    }
  } else {
    endContinuousAdjustment()
  }

  undoStack.value.push({
    features: cloneFeatureCollection(project.value.features),
    editOverrides: JSON.parse(JSON.stringify(project.value.editOverrides || {})),
    exportInclusions: JSON.parse(JSON.stringify(exportInclusions.value)),
    groupKey: isContinuous ? groupKey : undefined,
    version: currentVersion
  })
  currentVersion++
  isDirty.value = currentVersion !== savedVersion
  redoStack.value = []
}

function clearHistory() {
  undoStack.value = []
  redoStack.value = []
  endContinuousAdjustment()
  currentVersion = 0
  savedVersion = 0
}
const geometryCache = createGeometryCache()
const junctionGraph = shallowRef<JunctionTopologyGraph>(
  buildJunctionTopology({
    features: project.value.features,
    metadata: project.value.sourceMetadata,
    origin: project.value.projectionOrigin,
    selectedBounds: project.value.selectedBounds
  })
)
const viewSurfaces = shallowRef<ViewSurface[]>([])
const subordinateSurfaces = shallowRef<ViewSurface[]>([])
const lastRecomputationStats = ref<RecomputationStats | null>(null)

async function rebuildAllSurfaces(options: { rebuildTopology?: boolean; useWorker?: boolean } = {}) {
  const generationId = ++activeGeometryGenerationId
  const bridge = getEditorWorkerBridge()

  if (options.useWorker && bridge.isWorkerAvailable) {
    isGeneratingGeometry.value = true
    try {
      const result = await bridge.generateGeometry(project.value, viewMode.value, options)
      // Ignore obsolete processing results if project or edits changed during generation
      if (generationId !== activeGeometryGenerationId) {
        return
      }
      viewSurfaces.value = result.viewSurfaces
      subordinateSurfaces.value = result.subordinateSurfaces
    } catch (err: unknown) {
      if (generationId !== activeGeometryGenerationId) {
        return
      }
      // Fall back to main thread on error
      if (options.rebuildTopology ?? true) {
        junctionGraph.value = buildJunctionTopology({
          features: project.value.features,
          metadata: project.value.sourceMetadata,
          origin: project.value.projectionOrigin,
          selectedBounds: project.value.selectedBounds
        })
      }
      populateGeometryCache(
        geometryCache,
        project.value.features,
        viewMode.value,
        project.value.projectionOrigin,
        junctionGraph.value
      )
      viewSurfaces.value = flattenGeometryCache(geometryCache)
      subordinateSurfaces.value = flattenSubordinateSurfaces(geometryCache)
      lastRecomputationStats.value = geometryCache.lastStats
    } finally {
      if (generationId === activeGeometryGenerationId) {
        isGeneratingGeometry.value = false
      }
    }
    return
  }

  if (options.rebuildTopology ?? true) {
    junctionGraph.value = buildJunctionTopology({
      features: project.value.features,
      metadata: project.value.sourceMetadata,
      origin: project.value.projectionOrigin,
      selectedBounds: project.value.selectedBounds
    })
  }
  populateGeometryCache(
    geometryCache,
    project.value.features,
    viewMode.value,
    project.value.projectionOrigin,
    junctionGraph.value
  )
  viewSurfaces.value = flattenGeometryCache(geometryCache)
  subordinateSurfaces.value = flattenSubordinateSurfaces(geometryCache)
  lastRecomputationStats.value = geometryCache.lastStats
}

// Initialize default cache
rebuildAllSurfaces()

export interface SetProjectOptions {
  force?: boolean
  validate?: boolean
  confirmReplacement?: (message: string) => boolean
  useWorker?: boolean
}

export function handleBeforeUnload(e?: { preventDefault?: () => void; returnValue?: string }): string | void {
  if (isDirty.value) {
    if (e?.preventDefault) {
      e.preventDefault()
    }
    if (e) {
      e.returnValue = 'You have unsaved edits in the active project.'
    }
    return 'You have unsaved edits in the active project.'
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', ((e: BeforeUnloadEvent) => {
    handleBeforeUnload(e)
  }) as EventListener)
}

export function useEditorModel(initialProject?: ProjectEnvelope) {
  if (initialProject) {
    project.value = {
      ...initialProject,
      sourceFeatures: initialProject.sourceFeatures && initialProject.sourceFeatures.length > 0
        ? cloneFeatureCollection(initialProject.sourceFeatures)
        : cloneFeatureCollection(initialProject.features),
      editOverrides: initialProject.editOverrides
        ? JSON.parse(JSON.stringify(initialProject.editOverrides))
        : {}
    }
    viewMode.value = initialProject.editorSettings?.viewMode ?? 'data'
    facilityInferencePolicy.value = initialProject.editorSettings?.facilityInferencePolicy ?? 'none'
    selectedFeatureId.value = null
    selectedStripId.value = null
    selectedSurfaceId.value = null
    hoveredFeatureId.value = null
    hoveredSurfaceId.value = null
    isDirty.value = false
    if (initialProject.editorSettings?.layerVisibility) {
      layerVisibility.value = { ...DEFAULT_LAYER_VISIBILITY, ...initialProject.editorSettings.layerVisibility }
    } else {
      layerVisibility.value = { ...DEFAULT_LAYER_VISIBILITY }
    }
    if (initialProject.editorSettings?.exportInclusions) {
      exportInclusions.value = { ...DEFAULT_EXPORT_INCLUSIONS, ...initialProject.editorSettings.exportInclusions }
    } else {
      exportInclusions.value = { ...DEFAULT_EXPORT_INCLUSIONS }
    }
    if (initialProject.editorSettings?.clippingPolicy) {
      exportClippingPolicy.value = {
        ...DEFAULT_EXPORT_CLIPPING_POLICY,
        ...initialProject.editorSettings.clippingPolicy
      }
    } else {
      exportClippingPolicy.value = { ...DEFAULT_EXPORT_CLIPPING_POLICY }
    }
    clearHistory()
    rebuildAllSurfaces()
  }
  const activeSource = computed<'osm' | 'overture' | 'custom'>(() => {
    const src = project.value.sourceMetadata?.source
    if (src === 'osm' || src === 'overture') return src
    return 'custom'
  })


  const selectedFeature = computed<EditorFeature | null>(() => {
    if (!selectedFeatureId.value) return null
    const feat = project.value.features.find((f) => f.id === selectedFeatureId.value)
    if (feat) return feat
    const junc = junctionGraph.value?.getJunction(selectedFeatureId.value)
    if (junc) {
      const derived = deriveJunctionFeatures(junctionGraph.value, project.value.projectionOrigin)
      return derived.find((df) => df.id === junc.id) ?? null
    }
    return null
  })
  const selectedStrip = computed<CrossSectionStrip | null>(() => {
    if (!selectedFeature.value?.roadProfile?.strips || !selectedStripId.value) return null
    return (
      selectedFeature.value.roadProfile.strips.find(
        (s: CrossSectionStrip) => s.id === selectedStripId.value
      ) ?? null
    )
  })

  const selectedSurface = computed<ViewSurface | null>(() => {
    if (!selectedSurfaceId.value) return null
    return viewSurfaces.value.find((s) => s.id === selectedSurfaceId.value) ?? null
  })

  const hoveredFeature = computed<EditorFeature | null>(() => {
    if (!hoveredFeatureId.value) return null
    const feat = project.value.features.find((f) => f.id === hoveredFeatureId.value)
    if (feat) return feat
    const junc = junctionGraph.value?.getJunction(hoveredFeatureId.value)
    if (junc) {
      const derived = deriveJunctionFeatures(junctionGraph.value, project.value.projectionOrigin)
      return derived.find((df) => df.id === junc.id) ?? null
    }
    return null
  })

  function setHoveredFeature(featureId: string | null, surfaceId?: string | null): void {
    if (featureId) {
      const feat = project.value.features.find((f) => f.id === featureId)
      if (feat && !isHitTestable(feat.kind, feat.role)) {
        hoveredFeatureId.value = null
        hoveredSurfaceId.value = null
        return
      }
      if (!feat) {
        const junc = junctionGraph.value?.getJunction(featureId)
        if (junc && !isHitTestable('junction', 'junction')) {
          hoveredFeatureId.value = null
          hoveredSurfaceId.value = null
          return
        }
      }
    }
    hoveredFeatureId.value = featureId
    hoveredSurfaceId.value = surfaceId ?? null
  }

  const surfacesGeoJSON = computed<GeoJSON.FeatureCollection>(() => {
    const allSurfaces = [...viewSurfaces.value, ...subordinateSurfaces.value]
    const visibleSurfaces = allSurfaces.filter((surface) => {
      const cat = mapKindToCategory(surface.kind, surface.role)
      return (
        isLayerVisible(cat) &&
        (surface.kind ? isLayerVisible(surface.kind) : true) &&
        (surface.role ? isLayerVisible(surface.role) : true)
      )
    })

    // Deterministic draw order sort: lower draw order rendered earlier (bottom), higher rendered later (top).
    // Stable tie-breaker on surface.id.
    const sortedSurfaces = [...visibleSurfaces].sort((a, b) => {
      const orderA = a.drawOrder ?? (a.properties?.drawOrder as number | undefined) ?? 0
      const orderB = b.drawOrder ?? (b.properties?.drawOrder as number | undefined) ?? 0
      if (orderA !== orderB) {
        return orderA - orderB
      }
      return a.id.localeCompare(b.id)
    })

    return {
      type: 'FeatureCollection',
      features: sortedSurfaces.map((surface) => {
        const drawOrder =
          surface.drawOrder ?? (surface.properties?.drawOrder as number | undefined) ?? 0
        const layer =
          (surface.properties?.layer as number | undefined) ?? 0
        const bridge = Boolean(surface.properties?.bridge)
        const tunnel = Boolean(surface.properties?.tunnel)

        return {
          type: 'Feature',
          id: surface.id,
          geometry: surface.geometry,
          properties: {
            id: surface.id,
            parentFeatureId: surface.parentFeatureId,
            stripId: surface.stripId,
            role: surface.role,
            kind: surface.kind ?? surface.role,
            layer,
            bridge,
            tunnel,
            drawOrder,
            side: surface.properties?.side,
            direction: surface.properties?.direction,
            lateralPlacement: surface.properties?.lateralPlacement,
            coordinateOrderConvention: 'left_right_relative_to_source_coordinates',
            viewMode: surface.viewMode,
            isSelected: surface.parentFeatureId === selectedFeatureId.value,
            isStripSelected: Boolean(
              surface.stripId &&
                surface.stripId === selectedStripId.value &&
                surface.parentFeatureId === selectedFeatureId.value
            ),
            isSurfaceSelected: surface.id === selectedSurfaceId.value,
            isInferredWidth: Boolean(surface.properties.isInferredWidth),
            isInferredFacility: Boolean(surface.properties.isInferredFacility),
            ...surface.properties
          }
        }
      })
    }
  })

  function setLayerVisibility(category: string, visible: boolean): void {
    const updates: Record<string, boolean> = { [category]: visible }
    if (category === 'road' || category === 'carriageway') {
      updates.road = visible
      updates.carriageway = visible
    } else if (category === 'sidewalk' || category === 'footway') {
      updates.sidewalk = visible
      updates.footway = visible
    } else if (category === 'cycling') {
      updates.cycling = visible
      updates.bike_lane = visible
      updates.cycleway = visible
      updates.bike_facility = visible
    } else if (category === 'bike_lane') {
      updates.bike_lane = visible
      const cyclewayVis = isLayerVisible('cycleway')
      updates.cycling = visible || cyclewayVis
    } else if (category === 'cycleway' || category === 'bike_facility') {
      updates.cycleway = visible
      updates.bike_facility = visible
      const bikeLaneVis = isLayerVisible('bike_lane')
      updates.cycling = visible || bikeLaneVis
    }
    layerVisibility.value = {
      ...layerVisibility.value,
      ...updates
    }
    if (!project.value.editorSettings) {
      project.value.editorSettings = {}
    }
    project.value.editorSettings.layerVisibility = { ...layerVisibility.value }

    if (!visible) {
      if (selectedFeature.value && !isHitTestable(selectedFeature.value.kind, selectedFeature.value.role)) {
        selectedFeatureId.value = null
        selectedStripId.value = null
        selectedSurfaceId.value = null
      }
      if (hoveredFeature.value && !isHitTestable(hoveredFeature.value.kind, hoveredFeature.value.role)) {
        hoveredFeatureId.value = null
        hoveredSurfaceId.value = null
      }
    }
  }

  function toggleLayerVisibility(category: string): void {
    const current = isLayerVisible(category)
    setLayerVisibility(category, !current)
  }

  function isLayerVisible(category: string): boolean {
    if (category === 'road' || category === 'carriageway' || category === 'centerline') {
      return layerVisibility.value.road !== false && layerVisibility.value.carriageway !== false
    }
    if (category === 'cycling') {
      return (
        layerVisibility.value.cycling !== false &&
        (layerVisibility.value.bike_lane !== false || layerVisibility.value.cycleway !== false)
      )
    }
    if (category === 'bike_lane') {
      return layerVisibility.value.cycling !== false && layerVisibility.value.bike_lane !== false
    }
    if (category === 'cycleway' || category === 'bike_facility') {
      return (
        layerVisibility.value.cycling !== false &&
        layerVisibility.value.cycleway !== false &&
        layerVisibility.value.bike_facility !== false
      )
    }
    return layerVisibility.value[category] !== false
  }

  function isHitTestable(kind?: string, role?: string): boolean {
    const cat = mapKindToCategory(kind, role)
    if (!isLayerVisible(cat)) return false
    if (kind && !isLayerVisible(kind)) return false
    if (role && !isLayerVisible(role)) return false
    return true
  }

  function setExportInclusion(category: string, included: boolean, options?: EditOptions): void {
    const updates: Record<string, boolean> = { [category]: included }
    if (category === 'road' || category === 'carriageway') {
      updates.road = included
      updates.carriageway = included
    } else if (category === 'sidewalk' || category === 'footway') {
      updates.sidewalk = included
      updates.footway = included
    } else if (category === 'cycling') {
      updates.cycling = included
      updates.bike_lane = included
      updates.cycleway = included
      updates.bike_facility = included
    } else if (category === 'bike_lane') {
      updates.bike_lane = included
      const cyclewayInc = isExportIncluded('cycleway')
      updates.cycling = included || cyclewayInc
    } else if (category === 'cycleway' || category === 'bike_facility') {
      updates.cycleway = included
      updates.bike_facility = included
      const bikeLaneInc = isExportIncluded('bike_lane')
      updates.cycling = included || bikeLaneInc
    }

    const hasChange = Object.entries(updates).some(([k, v]) => exportInclusions.value[k] !== v)
    if (!hasChange) return

    recordSnapshot(options)

    exportInclusions.value = {
      ...exportInclusions.value,
      ...updates
    }
    if (!project.value.editorSettings) {
      project.value.editorSettings = {}
    }
    project.value.editorSettings.exportInclusions = { ...exportInclusions.value }
    isDirty.value = true
  }

  function toggleExportInclusion(category: string, options?: EditOptions): void {
    const current = isExportIncluded(category)
    setExportInclusion(category, !current, options)
  }

  function isExportIncluded(category: string): boolean {
    if (category === 'road' || category === 'carriageway') {
      return exportInclusions.value.road !== false && exportInclusions.value.carriageway !== false
    }
    if (category === 'sidewalk' || category === 'footway') {
      return exportInclusions.value.sidewalk !== false && exportInclusions.value.footway !== false
    }
    if (category === 'cycling') {
      return (
        exportInclusions.value.cycling !== false &&
        (exportInclusions.value.bike_lane !== false || exportInclusions.value.cycleway !== false)
      )
    }
    if (category === 'bike_lane') {
      return exportInclusions.value.cycling !== false && exportInclusions.value.bike_lane !== false
    }
    if (category === 'cycleway' || category === 'bike_facility') {
      return (
        exportInclusions.value.cycling !== false &&
        exportInclusions.value.cycleway !== false &&
        exportInclusions.value.bike_facility !== false
      )
    }
    return exportInclusions.value[category] !== false
  }

  function resetExportInclusions(options?: EditOptions): void {
    const hasChange = Object.entries(DEFAULT_EXPORT_INCLUSIONS).some(
      ([k, v]) => exportInclusions.value[k] !== v
    )
    if (!hasChange) return

    recordSnapshot(options)

    exportInclusions.value = { ...DEFAULT_EXPORT_INCLUSIONS }
    if (!project.value.editorSettings) {
      project.value.editorSettings = {}
    }
    project.value.editorSettings.exportInclusions = { ...exportInclusions.value }
    isDirty.value = true
  }


  const categoryCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {
      road: 0,
      carriageway: 0,
      building: 0,
      sidewalk: 0,
      footway: 0,
      bike_facility: 0,
      bike_lane: 0,
      cycleway: 0,
      cycling: 0,
      junction: 0,
      unsupported: 0
    }
    for (const f of project.value.features) {
      const k = (f.kind || f.role || 'unsupported') as string
      counts[k] = (counts[k] || 0) + 1
      if (k === 'road' || k === 'carriageway') {
        counts.road = (counts.road || 0) + (k === 'carriageway' ? 1 : 0)
        counts.carriageway = (counts.carriageway || 0) + (k === 'road' ? 1 : 0)
      }
      if (k === 'bike_facility' || k === 'cycleway') {
        counts.bike_facility = (counts.bike_facility || 0) + (k !== 'bike_facility' ? 1 : 0)
        counts.cycleway = (counts.cycleway || 0) + (k !== 'cycleway' ? 1 : 0)
      }
      if (k === 'sidewalk' || k === 'footway') {
        counts.sidewalk = (counts.sidewalk || 0) + (k !== 'sidewalk' ? 1 : 0)
        counts.footway = (counts.footway || 0) + (k !== 'footway' ? 1 : 0)
      }
    }
    if (counts.junction === 0 && junctionGraph.value) {
      counts.junction = junctionGraph.value.getAtGradeJunctions().length
    }
    // Cycling accounts for both standalone cycleways and on-road bike lanes / strips
    counts.cycling = project.value.features.filter((f) => {
      const k = (f.kind || f.role) as string
      return (
        k === 'bike_lane' ||
        k === 'bike_facility' ||
        k === 'cycleway' ||
        f.roadProfile?.strips?.some((s) => s.kind === 'bike_lane' || s.kind === 'cycleway')
      )
    }).length

    const attachedSidewalks = project.value.features.filter((f) => {
      const k = (f.kind || f.role) as string
      return k !== 'sidewalk' && k !== 'footway' && f.roadProfile?.strips?.some((s) => s.kind === 'sidewalk')
    }).length
    if (attachedSidewalks > 0) {
      counts.sidewalk = (counts.sidewalk || 0) + attachedSidewalks
      counts.footway = (counts.footway || 0) + attachedSidewalks
    }
    return counts
  })

  const exportSummary = computed<ExportSummary>(() => {
    const exclusions: ExportExclusionItem[] = []
    const excludedCategorySet = new Set<string>()

    if (!isExportIncluded('carriageway')) {
      excludedCategorySet.add('carriageway')
      excludedCategorySet.add('road')
      exclusions.push({
        category: 'carriageway',
        label: 'Carriageways',
        count: categoryCounts.value.carriageway || categoryCounts.value.road || 0
      })
    }

    if (!isExportIncluded('building')) {
      excludedCategorySet.add('building')
      exclusions.push({
        category: 'building',
        label: 'Buildings',
        count: categoryCounts.value.building || 0
      })
    }

    if (!isExportIncluded('sidewalk')) {
      excludedCategorySet.add('sidewalk')
      excludedCategorySet.add('footway')
      exclusions.push({
        category: 'sidewalk',
        label: 'Sidewalks',
        count: categoryCounts.value.sidewalk || 0
      })
    }

    if (!isExportIncluded('cycling')) {
      excludedCategorySet.add('cycling')
      excludedCategorySet.add('bike_lane')
      excludedCategorySet.add('cycleway')
      exclusions.push({
        category: 'cycling',
        label: 'Cycling Infrastructure',
        count: categoryCounts.value.cycling || 0
      })
    } else {
      if (!isExportIncluded('bike_lane')) {
        excludedCategorySet.add('bike_lane')
        exclusions.push({
          category: 'bike_lane',
          label: 'On-Road Bike Lanes',
          count: categoryCounts.value.bike_lane || 0
        })
      }
      if (!isExportIncluded('cycleway')) {
        excludedCategorySet.add('cycleway')
        exclusions.push({
          category: 'cycleway',
          label: 'Standalone Cycleways',
          count: categoryCounts.value.cycleway || 0
        })
      }
    }

    if (!isExportIncluded('junction')) {
      excludedCategorySet.add('junction')
      exclusions.push({
        category: 'junction',
        label: 'Junctions',
        count: categoryCounts.value.junction || 0
      })
    }

    if (!isExportIncluded('unsupported')) {
      excludedCategorySet.add('unsupported')
      exclusions.push({
        category: 'unsupported',
        label: 'Unsupported Features',
        count: categoryCounts.value.unsupported || 0
      })
    }

    const totalFeatures = project.value.features.length
    const excludedFeatures = project.value.features.filter((f) => {
      const cat = mapKindToCategory(f.kind, f.role)
      if ((cat === 'cycleway' || cat === 'bike_lane') && exportInclusions.value.cycling === false) {
        return true
      }
      if (exportInclusions.value[cat] === false) return true
      if (f.kind && exportInclusions.value[f.kind] === false) return true
      if (f.role && exportInclusions.value[f.role] === false) return true
      return false
    })

    const excludedFeatureCount = excludedFeatures.length
    const includedFeatureCount = Math.max(0, totalFeatures - excludedFeatureCount)
    const hasExclusions = exclusions.length > 0

    let summaryText = 'All active layers included in Godot export.'
    if (hasExclusions) {
      summaryText = `Excluding ${exclusions.map((e) => `${e.label} (${e.count})`).join(', ')} from Godot export.`
    }

    return {
      hasExclusions,
      excludedCategories: Array.from(excludedCategorySet),
      excludedFeatureCount,
      includedFeatureCount,
      totalFeatureCount: totalFeatures,
      summaryText,
      exclusions
    }
  })

  function getCategoryExplanation(category: string): string {
    const counts = categoryCounts.value
    switch (category) {
      case 'road':
      case 'carriageway':
        return (counts.carriageway || 0) > 0
          ? `${counts.carriageway} carriageway${counts.carriageway === 1 ? '' : 's'} present in source data.`
          : 'No carriageways or roads present in source data.'
      case 'building':
        return (counts.building || 0) > 0
          ? `${counts.building} building${counts.building === 1 ? '' : 's'} present in source data.`
          : 'No buildings present in source data.'
      case 'sidewalk':
      case 'footway':
        if ((counts.sidewalk || 0) > 0) {
          return `${counts.sidewalk} sidewalk / pedestrian facilit${counts.sidewalk === 1 ? 'y' : 'ies'} present in source data.`
        }
        return facilityInferencePolicy.value === 'none'
          ? 'No sidewalks or footways present in source data. Sidewalks are not inferred or invented solely because a road exists.'
          : `No source sidewalks present; inferred under active ${facilityInferencePolicy.value} policy.`
      case 'cycling':
        if ((counts.cycling || 0) > 0) {
          return `${counts.cycling} cycling facilit${counts.cycling === 1 ? 'y' : 'ies'} present in source data.`
        }
        return facilityInferencePolicy.value === 'none'
          ? 'No bike lanes or cycleways present in source data. Cycling facilities are not inferred or invented solely because a road exists.'
          : `No source cycling facilities present; inferred under active ${facilityInferencePolicy.value} policy.`
      case 'bike_lane':
        return (counts.bike_lane || 0) > 0
          ? `${counts.bike_lane} on-road bike lane${counts.bike_lane === 1 ? '' : 's'} present in source data.`
          : 'No on-road bike lanes present in source data. Cycling facilities are not inferred or invented.'
      case 'cycleway':
      case 'bike_facility':
        return (counts.cycleway || 0) > 0
          ? `${counts.cycleway} standalone cycleway${counts.cycleway === 1 ? '' : 's'} present in source data.`
          : 'No standalone cycleways present in source data. Cycling facilities are not inferred or invented.'
      case 'junction':
      case 'junction_surfaces':
        return (counts.junction || 0) > 0
          ? `${counts.junction} junction${counts.junction === 1 ? '' : 's'} present in source data.`
          : 'No junctions present in source data.'
      case 'unsupported':
        return (counts.unsupported || 0) > 0
          ? `${counts.unsupported} unsupported feature${counts.unsupported === 1 ? '' : 's'} preserved for round-tripping.`
          : 'No unsupported features. All source features are mapped to supported categories.'
      default:
        return ''
    }
  }

  const categoryAvailability = computed<Record<string, CategoryAvailability>>(() => {
    const counts = categoryCounts.value
    return {
      carriageway: {
        category: 'carriageway',
        label: 'Carriageways',
        count: counts.carriageway || 0,
        available: (counts.carriageway || 0) > 0,
        explanation: getCategoryExplanation('carriageway')
      },
      building: {
        category: 'building',
        label: 'Buildings',
        count: counts.building || 0,
        available: (counts.building || 0) > 0,
        explanation: getCategoryExplanation('building')
      },
      sidewalk: {
        category: 'sidewalk',
        label: 'Sidewalks',
        count: counts.sidewalk || 0,
        available: (counts.sidewalk || 0) > 0,
        explanation: getCategoryExplanation('sidewalk')
      },
      cycling: {
        category: 'cycling',
        label: 'Cycling Infrastructure',
        count: counts.cycling || 0,
        available: (counts.cycling || 0) > 0,
        explanation: getCategoryExplanation('cycling')
      },
      junction: {
        category: 'junction',
        label: 'Junctions',
        count: counts.junction || 0,
        available: (counts.junction || 0) > 0,
        explanation: getCategoryExplanation('junction')
      },
      unsupported: {
        category: 'unsupported',
        label: 'Unsupported',
        count: counts.unsupported || 0,
        available: (counts.unsupported || 0) > 0,
        explanation: getCategoryExplanation('unsupported')
      }
    }
  })

  function setImportProgress(stage: string | null, percent = 0) {
    if (stage === null) {
      isImporting.value = false
      importProgress.value = null
    } else {
      isImporting.value = true
      importProgress.value = { stage, percent }
    }
  }

  function setViewMode(mode: ViewMode) {
    viewMode.value = mode
    if (!project.value.editorSettings) {
      project.value.editorSettings = {}
    }
    project.value.editorSettings.viewMode = mode
    project.value.editorSettings.layerVisibility = { ...layerVisibility.value }
    project.value.editorSettings.exportInclusions = { ...exportInclusions.value }
    rebuildAllSurfaces({ rebuildTopology: false })
    // Keep selected surface stable across display mode changes
    if (selectedFeatureId.value) {
      if (selectedStripId.value) {
        const surf = viewSurfaces.value.find(
          (s) => s.parentFeatureId === selectedFeatureId.value && s.stripId === selectedStripId.value
        )
        if (surf) {
          selectedSurfaceId.value = surf.id
        }
      } else {
        const surf = viewSurfaces.value.find(
          (s) => s.parentFeatureId === selectedFeatureId.value
        )
        if (surf) {
          selectedSurfaceId.value = surf.id
        }
      }
    }
  }

  /**
   * Safely replaces current project envelope.
   * If validation is enabled (default true) and fails, keeps current project intact.
   * If there are unsaved edits (isDirty) and force is not specified, prompts or warns.
   */
  function setProject(newProject: ProjectEnvelope, options: SetProjectOptions = {}): boolean {
    const shouldValidate = options.validate ?? true
    if (shouldValidate) {
      const valResult = validateImportPayload(newProject)
      lastImportValidation.value = valResult
      if (!valResult.valid) {
        lastImportError.value = valResult.errors.join('; ')
        actionableImportAdvice.value = valResult.actionableAdvice && valResult.actionableAdvice.length > 0
          ? valResult.actionableAdvice[0]
          : 'Action: Review input payload data and fix validation errors before reloading.'
        return false
      }
      lastImportError.value = null
      actionableImportAdvice.value = null
    }

    // Check unsaved edits
    if (isDirty.value && !options.force) {
      const confirmFn = options.confirmReplacement
        ?? (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : undefined)
        ?? (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function' ? globalThis.confirm : undefined)
      if (confirmFn) {
        const confirmed = confirmFn('You have unsaved edits in the active project. Replace anyway?')
        if (!confirmed) {
          return false
        }
      } else {
        return false
      }
    }

    project.value = {
      ...newProject,
      sourceFeatures: newProject.sourceFeatures && newProject.sourceFeatures.length > 0
        ? cloneFeatureCollection(newProject.sourceFeatures)
        : cloneFeatureCollection(newProject.features),
      editOverrides: newProject.editOverrides
        ? JSON.parse(JSON.stringify(newProject.editOverrides))
        : {}
    }
    if (newProject.editorSettings?.viewMode) {
      viewMode.value = newProject.editorSettings.viewMode
    }
    selectedFeatureId.value = null
    selectedStripId.value = null
    selectedSurfaceId.value = null
    isDirty.value = false
    if (newProject.editorSettings?.layerVisibility) {
      layerVisibility.value = { ...DEFAULT_LAYER_VISIBILITY, ...newProject.editorSettings.layerVisibility }
    } else {
      layerVisibility.value = { ...DEFAULT_LAYER_VISIBILITY }
    }
    if (newProject.editorSettings?.exportInclusions) {
      exportInclusions.value = { ...DEFAULT_EXPORT_INCLUSIONS, ...newProject.editorSettings.exportInclusions }
    } else {
      exportInclusions.value = { ...DEFAULT_EXPORT_INCLUSIONS }
    }
    facilityInferencePolicy.value = newProject.editorSettings?.facilityInferencePolicy ?? 'none'
    if (newProject.editorSettings?.clippingPolicy) {
      exportClippingPolicy.value = {
        ...DEFAULT_EXPORT_CLIPPING_POLICY,
        ...newProject.editorSettings.clippingPolicy
      }
    } else {
      exportClippingPolicy.value = { ...DEFAULT_EXPORT_CLIPPING_POLICY }
    }
    clearHistory()
    rebuildAllSurfaces({ useWorker: options.useWorker })
    return true
  }

  function updateFeature(
    featureId: string,
    mutator: (f: EditorFeature) => void,
    options?: EditOptions
  ): boolean {
    const idx = project.value.features.findIndex((f) => f.id === featureId)
    if (idx === -1) return false
    const fClone = cloneFeature(project.value.features[idx])
    mutator(fClone)
    if (JSON.stringify(fClone) === JSON.stringify(project.value.features[idx])) {
      return false
    }
    fClone.revision = (fClone.revision ?? 1) + 1
    const groupKey = options?.groupKey || (options?.continuous ? featureId : undefined)
    recordSnapshot(groupKey ? { ...options, groupKey } : options)
    const newFeatures = [...project.value.features]
    newFeatures[idx] = fClone
    project.value = {
      ...project.value,
      features: newFeatures
    }
    isDirty.value = true
    activeGeometryGenerationId++
    getEditorWorkerBridge().cancelPending()

    const stats = recomputeAffectedGeometryImpl(
      geometryCache,
      featureId,
      project.value.features,
      viewMode.value,
      project.value.projectionOrigin,
      junctionGraph.value
    )
    viewSurfaces.value = flattenGeometryCache(geometryCache)
    subordinateSurfaces.value = flattenSubordinateSurfaces(geometryCache)
    lastRecomputationStats.value = stats

    return true
  }

  function updateCarriagewayWidth(
    featureId: string,
    widthMeters: number,
    unit = 'm',
    options?: EditOptions
  ): boolean {
    const val = validatePositiveWidth(widthMeters, 'Carriageway width', { min: 0.5, max: 100 })
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      f.roadProfile.carriagewayWidthMeters = {
        value: widthMeters,
        unit,
        provenance: 'user_edited',
        parsedStatus: 'valid'
      }
      f.roadProfile.widthResolutionTier = 'user_override'
      f.inferred.width = false
      recalculateRoadStrips(f.roadProfile)
      const stripVal = validateStripTotals(f.roadProfile.strips)
      if (!stripVal.valid) return
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }

  function updateBuildingHeight(
    featureId: string,
    heightMeters: number,
    unit = 'm',
    options?: EditOptions
  ): boolean {
    const val = validateBuildingHeight(heightMeters)
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.buildingProfile) f.buildingProfile = {}
      f.buildingProfile.heightMeters = {
        value: heightMeters,
        unit,
        provenance: 'user_edited',
        parsedStatus: 'valid'
      }
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        buildingProfile: JSON.parse(JSON.stringify(f.buildingProfile))
      }
    }, options)
  }

  function updateBuildingLevels(
    featureId: string,
    levels: number,
    unit = 'levels',
    options?: EditOptions
  ): boolean {
    const val = validateBuildingLevels(levels)
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.buildingProfile) f.buildingProfile = {}
      f.buildingProfile.levels = {
        value: levels,
        unit,
        provenance: 'user_edited',
        parsedStatus: 'valid'
      }
      // If height was inferred or unset, derive height from levels (3m / floor)
      if (!f.buildingProfile.heightMeters || f.buildingProfile.heightMeters.provenance === 'inferred') {
        f.buildingProfile.heightMeters = {
          value: levels * 3.0,
          unit: 'm',
          provenance: 'inferred',
          parsedStatus: 'valid'
        }
      }
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        buildingProfile: JSON.parse(JSON.stringify(f.buildingProfile))
      }
    }, options)
  }

  function updateRoadLanes(
    featureId: string,
    lanes: number,
    options?:
      | {
          forwardLanes?: number | null
          backwardLanes?: number | null
          unit?: string
          continuous?: boolean
          groupKey?: string
        }
      | string
  ): boolean {
    const opts = typeof options === 'string' ? { unit: options } : options || {}
    const unit = opts.unit || 'count'
    const lanesVal = validateRoadLanes(lanes, {
      forwardLanes: opts.forwardLanes,
      backwardLanes: opts.backwardLanes
    })
    if (!lanesVal.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      if (f.roadProfile.direction) {
        const propVal = validateRoadProperties({
          direction: f.roadProfile.direction,
          lanes,
          forwardLanes: opts.forwardLanes,
          backwardLanes: opts.backwardLanes
        })
        if (!propVal.valid) return
      }
      if (!f.roadProfile) return
      f.roadProfile.lanes = {
        value: lanes,
        unit,
        provenance: 'user_edited',
        parsedStatus: 'valid'
      }
      if (!f.properties) f.properties = {}
      f.properties.lanes = lanes
      if (opts.forwardLanes !== undefined) {
        if (opts.forwardLanes !== null && opts.forwardLanes >= 0) {
          f.roadProfile.forwardLanes = {
            value: opts.forwardLanes,
            unit: 'count',
            provenance: 'user_edited',
            parsedStatus: 'valid'
          }
          f.properties['lanes:forward'] = opts.forwardLanes
        } else {
          delete f.roadProfile.forwardLanes
          delete f.properties['lanes:forward']
        }
      }
      if (opts.backwardLanes !== undefined) {
        if (opts.backwardLanes !== null && opts.backwardLanes >= 0) {
          f.roadProfile.backwardLanes = {
            value: opts.backwardLanes,
            unit: 'count',
            provenance: 'user_edited',
            parsedStatus: 'valid'
          }
          f.properties['lanes:backward'] = opts.backwardLanes
        } else {
          delete f.roadProfile.backwardLanes
          delete f.properties['lanes:backward']
        }
      }
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, typeof options === 'object' ? { continuous: options.continuous, groupKey: options.groupKey } : undefined)
  }

  function updateRoadSurface(featureId: string, surface: string, options?: EditOptions): boolean {
    const val = validateRoadProperties({ surface })
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      f.roadProfile.surface = {
        value: surface,
        provenance: 'user_edited',
        parsedStatus: 'valid'
      }
      if (!f.properties) f.properties = {}
      f.properties.surface = surface
      for (const strip of f.roadProfile.strips) {
        if (strip.kind === 'carriageway' || strip.side === 'center') {
          strip.surface = surface
        }
      }
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }

  function updateRoadSpeedLimit(
    featureId: string,
    speedLimit: number | null,
    unit = 'km/h',
    options?: EditOptions
  ): boolean {
    const val = validateRoadSpeedLimit(speedLimit)
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      if (speedLimit !== null && speedLimit > 0) {
        f.roadProfile.speedLimit = {
          value: speedLimit,
          unit,
          provenance: 'user_edited',
          parsedStatus: 'valid'
        }
        if (!f.properties) f.properties = {}
        f.properties.maxspeed = `${speedLimit} ${unit}`
      } else {
        delete f.roadProfile.speedLimit
        if (f.properties) {
          delete f.properties.maxspeed
        }
      }
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }

  function updateRoadHighwayClass(featureId: string, highwayClass: string, options?: EditOptions): boolean {
    const val = validateRoadProperties({ highwayClass })
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      f.roadProfile.highwayClass = highwayClass
      if (!f.properties) f.properties = {}
      f.properties.highway = highwayClass
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }
  function updateStripWidth(
    featureId: string,
    stripId: string,
    widthMeters: number,
    options?: EditOptions
  ): boolean {
    const val = validatePositiveWidth(widthMeters, 'Strip width', { min: 0.1, max: 50 })
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile?.strips) return
      const strip = f.roadProfile.strips.find((s: CrossSectionStrip) => s.id === stripId)
      if (!strip) return
      strip.widthMeters = widthMeters
      strip.provenance = 'user_edited'
      strip.width = {
        value: widthMeters,
        unit: 'm',
        provenance: 'user_edited',
        parsedStatus: 'valid'
      }
      if (strip.kind === 'carriageway' || strip.side === 'center') {
        f.roadProfile.carriagewayWidthMeters = {
          value: widthMeters,
          unit: 'm',
          provenance: 'user_edited',
          parsedStatus: 'valid'
        }
        f.roadProfile.widthResolutionTier = 'user_override'
        f.inferred.width = false
      }
      recalculateRoadStrips(f.roadProfile)
      const stripVal = validateStripTotals(f.roadProfile.strips)
      if (!stripVal.valid) return
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }
  function updateRoadSidewalks(
    featureId: string,
    options: {
      presence?: FacilityPresence
      left?: boolean
      right?: boolean
      leftWidthMeters?: number
      rightWidthMeters?: number
      widthMeters?: number
      continuous?: boolean
      groupKey?: string
    }
  ): boolean {
    if (options.leftWidthMeters !== undefined) {
      const val = validatePositiveWidth(options.leftWidthMeters, 'Left sidewalk width', { min: 0.2, max: 20 })
      if (!val.valid) return false
    }
    if (options.rightWidthMeters !== undefined) {
      const val = validatePositiveWidth(options.rightWidthMeters, 'Right sidewalk width', { min: 0.2, max: 20 })
      if (!val.valid) return false
    }
    if (options.widthMeters !== undefined) {
      const val = validatePositiveWidth(options.widthMeters, 'Sidewalk width', { min: 0.2, max: 20 })
      if (!val.valid) return false
    }
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      const currentSw = f.roadProfile.sidewalks ?? {
        presence: 'unknown',
        left: false,
        right: false,
        provenance: 'inferred'
      }

      let left = options.left !== undefined ? options.left : currentSw.left
      let right = options.right !== undefined ? options.right : currentSw.right
      if (options.presence !== undefined) {
        if (options.presence === 'absent') {
          left = false
          right = false
        } else if (options.presence === 'present' && options.left === undefined && options.right === undefined && !left && !right) {
          left = true
          right = true
        }
      }

      const presence: FacilityPresence =
        options.presence !== undefined
          ? options.presence
          : (left || right ? 'present' : 'absent')

      const leftWidth =
        options.leftWidthMeters ??
        options.widthMeters ??
        currentSw.leftWidthMeters ??
        f.roadProfile.strips.find((s) => s.kind === 'sidewalk' && s.side === 'left')?.widthMeters ??
        1.8
      const rightWidth =
        options.rightWidthMeters ??
        options.widthMeters ??
        currentSw.rightWidthMeters ??
        f.roadProfile.strips.find((s) => s.kind === 'sidewalk' && s.side === 'right')?.widthMeters ??
        1.8

      f.roadProfile.sidewalks = {
        ...currentSw,
        presence,
        left,
        right,
        leftPresence: left ? 'present' : 'absent',
        rightPresence: right ? 'present' : 'absent',
        provenance: 'user_edited',
        leftWidthMeters: left ? leftWidth : undefined,
        rightWidthMeters: right ? rightWidth : undefined
      }
      f.inferred.sidewalk = false

      // Synchronize strips
      const strips = f.roadProfile.strips.filter((s) => s.kind !== 'sidewalk')
      if (left) {
        strips.unshift({
          id: `${featureId}_sw_l`,
          kind: 'sidewalk',
          side: 'left',
          widthMeters: leftWidth,
          width: { value: leftWidth, unit: 'm', provenance: 'user_edited' },
          provenance: 'user_edited',
          direction: 'both',
          surface: 'concrete',
          offsetMeters: -leftWidth / 2.0
        })
      }
      if (right) {
        strips.push({
          id: `${featureId}_sw_r`,
          kind: 'sidewalk',
          side: 'right',
          widthMeters: rightWidth,
          width: { value: rightWidth, unit: 'm', provenance: 'user_edited' },
          provenance: 'user_edited',
          direction: 'both',
          surface: 'concrete',
          offsetMeters: rightWidth / 2.0
        })
      }
      f.roadProfile.strips = strips

      // Update profile flags
      const flags = (f.roadProfile.profileFlags || []).filter(
        (fl) => fl !== 'inferred_sidewalks' && fl !== 'asymmetric_sidewalks'
      )
      if (left !== right || (left && right && leftWidth !== rightWidth)) {
        flags.push('asymmetric_sidewalks')
      }
      f.roadProfile.profileFlags = flags

      recalculateRoadStrips(f.roadProfile)
      const stripVal = validateStripTotals(f.roadProfile.strips)
      if (!stripVal.valid) return
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, { continuous: options.continuous, groupKey: options.groupKey })
  }

  function updateRoadCycleFacilities(
    featureId: string,
    options: {
      presence?: FacilityPresence
      left?: boolean
      right?: boolean
      kind?: 'lane' | 'track' | 'shared' | 'none'
      leftKind?: 'lane' | 'track' | 'shared' | 'none'
      rightKind?: 'lane' | 'track' | 'shared' | 'none'
      leftWidthMeters?: number
      rightWidthMeters?: number
      widthMeters?: number
      continuous?: boolean
      groupKey?: string
    }
  ): boolean {
    if (options.leftWidthMeters !== undefined) {
      const val = validatePositiveWidth(options.leftWidthMeters, 'Left cycle facility width', { min: 0.2, max: 20 })
      if (!val.valid) return false
    }
    if (options.rightWidthMeters !== undefined) {
      const val = validatePositiveWidth(options.rightWidthMeters, 'Right cycle facility width', { min: 0.2, max: 20 })
      if (!val.valid) return false
    }
    if (options.widthMeters !== undefined) {
      const val = validatePositiveWidth(options.widthMeters, 'Cycle facility width', { min: 0.2, max: 20 })
      if (!val.valid) return false
    }
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      const currentCycle = f.roadProfile.cycleFacilities ?? {
        presence: 'unknown',
        left: false,
        right: false,
        provenance: 'inferred'
      }

      let left = options.left !== undefined ? options.left : currentCycle.left
      let right = options.right !== undefined ? options.right : currentCycle.right
      if (options.presence !== undefined) {
        if (options.presence === 'absent') {
          left = false
          right = false
        } else if (options.presence === 'present' && options.left === undefined && options.right === undefined && !left && !right) {
          left = true
          right = true
        }
      }

      const presence: FacilityPresence =
        options.presence !== undefined
          ? options.presence
          : (left || right ? 'present' : 'absent')

      const kind = options.kind ?? currentCycle.kind ?? 'lane'
      const leftKind = options.leftKind ?? options.kind ?? currentCycle.leftCycleKind ?? kind
      const rightKind = options.rightKind ?? options.kind ?? currentCycle.rightCycleKind ?? kind
      const defaultLeftWidth = leftKind === 'track' ? 2.0 : 1.5
      const defaultRightWidth = rightKind === 'track' ? 2.0 : 1.5

      const leftWidth =
        options.leftWidthMeters ??
        options.widthMeters ??
        currentCycle.leftWidthMeters ??
        f.roadProfile.strips.find((s) => s.kind === 'bike_lane' && s.side === 'left')?.widthMeters ??
        defaultLeftWidth
      const rightWidth =
        options.rightWidthMeters ??
        options.widthMeters ??
        currentCycle.rightWidthMeters ??
        f.roadProfile.strips.find((s) => s.kind === 'bike_lane' && s.side === 'right')?.widthMeters ??
        defaultRightWidth

      f.roadProfile.cycleFacilities = {
        ...currentCycle,
        presence,
        left,
        right,
        leftPresence: left ? 'present' : 'absent',
        rightPresence: right ? 'present' : 'absent',
        kind,
        leftCycleKind: leftKind,
        rightCycleKind: rightKind,
        provenance: 'user_edited',
        leftWidthMeters: left ? leftWidth : undefined,
        rightWidthMeters: right ? rightWidth : undefined
      }
      f.inferred.bikeLane = false

      // Synchronize strips
      const strips = f.roadProfile.strips.filter((s) => s.kind !== 'bike_lane')
      if (left) {
        strips.push({
          id: `${featureId}_bike_l`,
          kind: 'bike_lane',
          facilityKind: leftKind,
          side: 'left',
          widthMeters: leftWidth,
          width: { value: leftWidth, unit: 'm', provenance: 'user_edited' },
          provenance: 'user_edited',
          direction: f.roadProfile.direction ?? 'both',
          surface: 'asphalt',
          offsetMeters: -leftWidth / 2.0
        })
      }
      if (right) {
        strips.push({
          id: `${featureId}_bike_r`,
          kind: 'bike_lane',
          facilityKind: rightKind,
          side: 'right',
          widthMeters: rightWidth,
          width: { value: rightWidth, unit: 'm', provenance: 'user_edited' },
          provenance: 'user_edited',
          direction: f.roadProfile.direction ?? 'both',
          surface: 'asphalt',
          offsetMeters: rightWidth / 2.0
        })
      }
      f.roadProfile.strips = strips

      // Update profile flags
      const flags = (f.roadProfile.profileFlags || []).filter(
        (fl) => fl !== 'inferred_cycle_facilities' && fl !== 'asymmetric_cycle_facilities'
      )
      if (left !== right || leftKind !== rightKind || (left && right && leftWidth !== rightWidth)) {
        flags.push('asymmetric_cycle_facilities')
      }
      f.roadProfile.profileFlags = flags

      recalculateRoadStrips(f.roadProfile)
      const stripVal = validateStripTotals(f.roadProfile.strips)
      if (!stripVal.valid) return
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, { continuous: options.continuous, groupKey: options.groupKey })
  }

  function updateRoadDirection(
    featureId: string,
    direction: 'forward' | 'backward' | 'both',
    options?: EditOptions
  ): boolean {
    const val = validateRoadProperties({ direction })
    if (!val.valid) return false
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      const propVal = validateRoadProperties({
        direction,
        lanes: f.roadProfile.lanes?.value,
        forwardLanes: f.roadProfile.forwardLanes?.value,
        backwardLanes: f.roadProfile.backwardLanes?.value
      })
      if (!propVal.valid) return
      f.roadProfile.direction = direction
      f.roadProfile.oneWay = direction !== 'both'
      for (const strip of f.roadProfile.strips) {
        if (strip.kind === 'carriageway' || strip.side === 'center') {
          strip.direction = direction
        }
      }
      // Note: Strip left/right convention is relative to source coordinate order,
      // NOT travel direction. Left and right strip placements remain preserved.
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }

  function reverseRoadGeometry(featureId: string, options?: EditOptions): boolean {
    return updateFeature(featureId, (f) => {
      if (!f.roadProfile) return
      // 1. Invert coordinate order of the LineString via effectiveGeometry without mutating sourceGeometry
      const activeGeom = f.effectiveGeometry || f.sourceGeometry
      if (activeGeom?.type === 'LineString' && Array.isArray(activeGeom.coordinates)) {
        const coords = (activeGeom as GeoJSON.LineString).coordinates
        f.effectiveGeometry = {
          type: 'LineString',
          coordinates: [...coords].reverse()
        }
      }
      if (f.nodes && Array.isArray(f.nodes)) {
        f.nodes = [...f.nodes].reverse()
      }
      if (f.segmentRelative?.between) {
        const [start, end] = f.segmentRelative.between
        f.segmentRelative.between = [Number((1.0 - end).toFixed(6)), Number((1.0 - start).toFixed(6))]
      }

      // 2. Travel direction inverts (forward <-> backward)
      if (f.roadProfile.direction === 'forward') {
        f.roadProfile.direction = 'backward'
      } else if (f.roadProfile.direction === 'backward') {
        f.roadProfile.direction = 'forward'
      }

      // 3. To preserve the physical facilities and layout relative to the new coordinate sequence,
      // what was on the left of the old sequence is now on the right of the new sequence
      for (const strip of f.roadProfile.strips) {
        if (strip.side === 'left') {
          strip.side = 'right'
        } else if (strip.side === 'right') {
          strip.side = 'left'
        }
        if (strip.direction === 'forward') {
          strip.direction = 'backward'
        } else if (strip.direction === 'backward') {
          strip.direction = 'forward'
        }
      }

      // 4. Sidewalks and cycle facilities left/right swap
      if (f.roadProfile.sidewalks) {
        const sw = f.roadProfile.sidewalks
        const tmpLeft = sw.left
        sw.left = sw.right
        sw.right = tmpLeft
        const tmpLeftPres = sw.leftPresence
        sw.leftPresence = sw.rightPresence
        sw.rightPresence = tmpLeftPres
      }
      if (f.roadProfile.cycleFacilities) {
        const cy = f.roadProfile.cycleFacilities
        const tmpLeft = cy.left
        cy.left = cy.right
        cy.right = tmpLeft
        const tmpLeftPres = cy.leftPresence
        cy.leftPresence = cy.rightPresence
        cy.rightPresence = tmpLeftPres
      }

      // 5. Recalculate strip lateral placements with the swapped sides
      recalculateRoadStrips(f.roadProfile)

      // 6. Record edit override
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        effectiveGeometry: f.effectiveGeometry ? JSON.parse(JSON.stringify(f.effectiveGeometry)) : undefined,
        roadProfile: JSON.parse(JSON.stringify(f.roadProfile))
      }
    }, options)
  }

  function updateFeatureGeometry(
    featureId: string,
    geometry: GeoJSON.Geometry,
    options?: EditOptions
  ): boolean {
    return updateFeature(featureId, (f) => {
      f.effectiveGeometry = JSON.parse(JSON.stringify(geometry))
      if (!project.value.editOverrides) {
        project.value.editOverrides = {}
      }
      project.value.editOverrides[featureId] = {
        ...project.value.editOverrides[featureId],
        featureId,
        effectiveGeometry: JSON.parse(JSON.stringify(geometry))
      }
    }, options)
  }

  function setFacilityInferencePolicy(policy: FacilityInferencePolicy): number {
    facilityInferencePolicy.value = policy
    if (!project.value.editorSettings) {
      project.value.editorSettings = {}
    }
    project.value.editorSettings.facilityInferencePolicy = policy

    let updatedCount = 0
    for (const f of project.value.features) {
      if ((f.kind === 'road' || f.role === 'road') && f.roadProfile && f.sourceGeometry?.type === 'LineString') {
        const highwayClass = f.roadProfile.highwayClass || 'residential'
        const tags = (f.properties || {}) as Record<string, string>
        const oneWay = f.roadProfile.oneWay ?? false
        const isOverture = f.sourceReference?.type?.startsWith('overture') || Boolean(f.overtureSources)

        const sidewalkSource = isOverture
          ? extractOvertureSidewalkSourceEvidence(f.properties || {}, highwayClass)
          : extractOsmSidewalkSourceEvidence(tags)
        const cycleSource = isOverture
          ? extractOvertureCycleSourceEvidence(f.properties || {}, highwayClass)
          : extractOsmCycleSourceEvidence(tags, highwayClass)

        const decision = resolveFacilityInference({
          highwayClass,
          policy,
          sidewalkSource,
          cycleSource,
          oneWay
        })

        const currentHasLeftSw = f.roadProfile.strips.some((s) => s.kind === 'sidewalk' && s.side === 'left')
        const currentHasRightSw = f.roadProfile.strips.some((s) => s.kind === 'sidewalk' && s.side === 'right')
        const currentHasLeftCycle = f.roadProfile.strips.some((s) => s.kind === 'bike_lane' && s.side === 'left')
        const currentHasRightCycle = f.roadProfile.strips.some((s) => s.kind === 'bike_lane' && s.side === 'right')

        if (
          currentHasLeftSw !== decision.hasLeftSidewalk ||
          currentHasRightSw !== decision.hasRightSidewalk ||
          currentHasLeftCycle !== decision.hasLeftCycle ||
          currentHasRightCycle !== decision.hasRightCycle
        ) {
          const baseCarriagewayWidth =
            f.roadProfile.roadwayWidthMeters?.value ?? f.roadProfile.carriagewayWidthMeters.value
          const {
            strips,
            totalCorridorWidthMeters,
            effectiveCarriagewayWidthMeters,
            effectiveRoadwayWidthMeters
          } = buildRoadCrossSectionStrips({
            featureId: f.id,
            carriagewayWidth: baseCarriagewayWidth,
            isWidthInferred: f.roadProfile.carriagewayWidthMeters.provenance === 'inferred',
            surfaceValue: f.roadProfile.surface?.value,
            direction: f.roadProfile.direction,
            oneWay: f.roadProfile.oneWay,
            drivingSide: f.roadProfile.drivingSide,
            hasLeftCycle: decision.hasLeftCycle,
            hasRightCycle: decision.hasRightCycle,
            cycleKind: decision.cycleKind,
            cycleInferred: decision.cycleInferred,
            hasLeftSidewalk: decision.hasLeftSidewalk,
            hasRightSidewalk: decision.hasRightSidewalk,
            sidewalkInferred: decision.sidewalkInferred,
            widthResolutionTier: f.roadProfile.widthResolutionTier
          })

          f.roadProfile.strips = strips
          f.roadProfile.totalCorridorWidthMeters = totalCorridorWidthMeters
          f.roadProfile.totalCorridorWidth = {
            value: totalCorridorWidthMeters,
            unit: 'm',
            provenance: (decision.sidewalkInferred || decision.cycleInferred || f.roadProfile.carriagewayWidthMeters.provenance === 'inferred') ? 'inferred' : 'source'
          }
          f.roadProfile.carriagewayWidthMeters.value = effectiveCarriagewayWidthMeters
          if (f.roadProfile.roadwayWidthMeters) {
            f.roadProfile.roadwayWidthMeters.value = effectiveRoadwayWidthMeters
          }
          f.roadProfile.facilityInferencePolicy = policy

          f.roadProfile.sidewalks = {
            presence: decision.sidewalkPresence,
            left: decision.hasLeftSidewalk,
            right: decision.hasRightSidewalk,
            leftPresence: decision.leftSidewalkPresence,
            rightPresence: decision.rightSidewalkPresence,
            provenance: decision.sidewalkProvenance,
            sourceEvidence: decision.sidewalkSourceEvidence,
            inferencePolicy: decision.sidewalkInferencePolicy,
            inferenceReason: decision.sidewalkInferenceReason,
            leftWidthMeters: decision.hasLeftSidewalk ? 1.8 : undefined,
            rightWidthMeters: decision.hasRightSidewalk ? 1.8 : undefined
          }

          f.roadProfile.cycleFacilities = {
            presence: decision.cyclePresence,
            left: decision.hasLeftCycle,
            right: decision.hasRightCycle,
            leftPresence: decision.leftCyclePresence,
            rightPresence: decision.rightCyclePresence,
            kind: decision.cycleKind,
            provenance: decision.cycleProvenance,
            sourceEvidence: decision.cycleSourceEvidence,
            inferencePolicy: decision.cycleInferencePolicy,
            inferenceReason: decision.cycleInferenceReason,
            leftWidthMeters: decision.hasLeftCycle ? (decision.cycleKind === 'track' ? 2.0 : 1.5) : undefined,
            rightWidthMeters: decision.hasRightCycle ? (decision.cycleKind === 'track' ? 2.0 : 1.5) : undefined
          }

          f.inferred.sidewalk = decision.sidewalkInferred
          f.inferred.bikeLane = decision.cycleInferred

          const flags = (f.roadProfile.profileFlags || []).filter(
            (fl) => fl !== 'inferred_sidewalks' && fl !== 'inferred_cycle_facilities'
          )
          if (decision.sidewalkInferred) flags.push('inferred_sidewalks')
          if (decision.cycleInferred) flags.push('inferred_cycle_facilities')
          f.roadProfile.profileFlags = flags

          if (decision.sidewalkInferred || decision.cycleInferred) {
            f.roadProfile.laneAccuracyClaimed = false
            f.roadProfile.laneAccuracyReason = 'Road facilities inferred via policy; detailed lane accuracy not claimed.'
          }

          updatedCount++
        }
      }
    }

    associateSeparateFacilities(
      project.value.features,
      project.value.projectionOrigin ? [project.value.projectionOrigin.lon, project.value.projectionOrigin.lat] : undefined
    )
    isDirty.value = true
    if (updatedCount > 0) {
      rebuildAllSurfaces()
    }
    return updatedCount
  }

  function setExportClippingPolicy(policy: Partial<ExportClippingPolicy>): void {
    exportClippingPolicy.value = {
      ...exportClippingPolicy.value,
      ...policy
    }
  }

  /**
   * Serializes the current complete editor project into a reopenable ProjectEnvelope JSON structure.
   * Unlike exportProjectEnvelope, this does NOT filter out features excluded by export inclusions
   * and does NOT clip features or drop cross-section strips.
   * It preserves source metadata, source features, all editable features with their edits,
   * edit overrides, export inclusion settings, and complete editor view settings (viewMode, layerVisibility, etc.).
   */
  function saveProjectEnvelope(): ProjectEnvelope {
    const envelope: ProjectEnvelope = {
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      sourceMetadata: JSON.parse(JSON.stringify(project.value.sourceMetadata || { source: 'custom' })),
      selectedBounds: project.value.selectedBounds ? [...project.value.selectedBounds] : undefined,
      projectionOrigin: { ...project.value.projectionOrigin },
      projection: {
        type: 'equirectangular_local_tangent',
        earthRadius: 6378137.0,
        origin: { ...project.value.projectionOrigin },
        axes: {
          x: '+East (meters)',
          y: '+North (meters 2D tangent plane, +Up in Godot 3D)',
          z: '-North (meters in Godot 3D)'
        },
        unit: 'meter'
      },
      sourceFeatures: JSON.parse(
        JSON.stringify(
          project.value.sourceFeatures && project.value.sourceFeatures.length > 0
            ? project.value.sourceFeatures
            : project.value.features
        )
      ),
      features: JSON.parse(JSON.stringify(project.value.features)),
      editOverrides: JSON.parse(JSON.stringify(project.value.editOverrides || {})),
      editorSettings: {
        viewMode: viewMode.value,
        units: project.value.editorSettings?.units ?? 'metric',
        showInferredBadges: project.value.editorSettings?.showInferredBadges ?? true,
        coordinateOrderConvention: 'left_right_relative_to_source_coordinates',
        layerVisibility: { ...layerVisibility.value },
        exportInclusions: { ...exportInclusions.value },
        facilityInferencePolicy: facilityInferencePolicy.value,
        clippingPolicy: { ...exportClippingPolicy.value }
      },
      warnings: project.value.warnings ? [...project.value.warnings] : undefined
    }
    return envelope
  }

  function exportProjectEnvelope(options?: {
    inclusions?: Record<string, boolean>
    clippingPolicy?: ExportClippingPolicy
  }): ProjectEnvelope {
    const envelope = JSON.parse(JSON.stringify(project.value)) as ProjectEnvelope
    if (!envelope.editorSettings) {
      envelope.editorSettings = {}
    }
    envelope.editorSettings.viewMode = viewMode.value
    envelope.editorSettings.coordinateOrderConvention = 'left_right_relative_to_source_coordinates'
    envelope.editorSettings.layerVisibility = { ...layerVisibility.value }
    const activeInclusions = options?.inclusions ?? exportInclusions.value
    envelope.editorSettings.exportInclusions = { ...activeInclusions }
    const activeClippingPolicy = options?.clippingPolicy ?? exportClippingPolicy.value
    envelope.editorSettings.clippingPolicy = { ...activeClippingPolicy }
    envelope.editorSettings.facilityInferencePolicy = facilityInferencePolicy.value
    envelope.projection = {
      type: 'equirectangular_local_tangent',
      earthRadius: 6378137.0,
      origin: { ...project.value.projectionOrigin },
      axes: {
        x: '+East (meters)',
        y: '+North (meters 2D tangent plane, +Up in Godot 3D)',
        z: '-North (meters in Godot 3D)'
      },
      unit: 'meter'
    }
    envelope.features = envelope.features.filter((f) => {
      if (f.properties?.exportInclusion === false || (f as unknown as Record<string, unknown>).exportInclusion === false) {
        return false
      }
      const cat = mapKindToCategory(f.kind, f.role)
      if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
        return false
      }
      return (
        activeInclusions[cat] !== false &&
        activeInclusions[f.kind ?? ''] !== false &&
        activeInclusions[f.role ?? ''] !== false
      )
    })
    envelope.features.forEach((f) => {
      if (f.roadProfile?.strips) {
        f.roadProfile.strips = f.roadProfile.strips.filter((strip) => {
          const cat = mapKindToCategory(strip.kind)
          if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
            return false
          }
          return (
            activeInclusions[cat] !== false &&
            activeInclusions[strip.kind ?? ''] !== false
          )
        })
      }
    })
    const { envelope: clippedEnvelope } = applyExportClippingToEnvelope(
      envelope,
      activeClippingPolicy
    )
    return clippedEnvelope
  }

  function getSceneExportPreflight(options?: {
    inclusions?: Record<string, boolean>
    clippingPolicy?: ExportClippingPolicy
    assumptions?: string[]
  }): SceneExportPreflight {
    const activeInclusions = options?.inclusions ?? exportInclusions.value
    const activeClippingPolicy = options?.clippingPolicy ?? exportClippingPolicy.value

    // 1. Authoritative horizontal surfaces generated in realistic view mode
    const surfaces = generateViewSurfaces(
      project.value.features,
      'realistic',
      project.value.projectionOrigin,
      junctionGraph.value
    )

    const featureMap = new Map<string, EditorFeature>()
    for (const f of project.value.features) {
      featureMap.set(f.id, f)
    }

    // 2. Filter by export inclusions
    const includedSurfaces = surfaces.filter((surface) => {
      const cat = mapKindToCategory(surface.kind, surface.role)
      if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
        return false
      }
      if (surface.properties?.exportInclusion === false) {
        return false
      }
      const parent = surface.parentFeatureId ? featureMap.get(surface.parentFeatureId) : undefined
      if (
        parent &&
        (parent.properties?.exportInclusion === false ||
          (parent as unknown as Record<string, unknown>).exportInclusion === false)
      ) {
        return false
      }
      return (
        activeInclusions[cat] !== false &&
        activeInclusions[surface.kind ?? ''] !== false &&
        activeInclusions[surface.role ?? ''] !== false
      )
    })

    // 3. Apply export clipping
    const { surfaces: clippedSurfaces } = applyExportClippingToSurfaces(
      includedSurfaces,
      project.value.selectedBounds,
      project.value.projectionOrigin,
      activeClippingPolicy
    )

    const counts: SceneExportPreflightCounts = {
      totalFeatures: project.value.features.length,
      includedFeatures: 0,
      excludedFeatures: 0,
      totalSurfaces: 0,
      roads: 0,
      buildings: 0,
      sidewalks: 0,
      bikeLanes: 0,
      junctions: 0,
      unsupported: 0
    }

    for (const surface of clippedSurfaces) {
      const geomVal = validateGeometryStructure(surface.geometry)
      if (!geomVal.valid) {
        continue
      }
      const parent = surface.parentFeatureId ? featureMap.get(surface.parentFeatureId) : undefined
      const effectiveRole: FeatureRole = surface.role ?? (parent ? (parent.role ?? parent.kind) : 'unsupported')

      if (effectiveRole === 'carriageway' || effectiveRole === 'road') counts.roads++
      else if (effectiveRole === 'building') counts.buildings++
      else if (effectiveRole === 'sidewalk') counts.sidewalks++
      else if (effectiveRole === 'bike_lane' || effectiveRole === 'cycleway' || effectiveRole === 'bike_facility')
        counts.bikeLanes++
      else if (effectiveRole === 'junction') counts.junctions++
      else counts.unsupported++
      counts.totalSurfaces++
    }

    // Source features breakdown
    const excludedFeaturesList = project.value.features.filter((f) => {
      const cat = mapKindToCategory(f.kind, f.role)
      if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
        return true
      }
      if (
        activeInclusions[cat] === false ||
        activeInclusions[f.kind] === false ||
        (f.role && activeInclusions[f.role] === false)
      ) {
        return true
      }
      if (
        f.properties?.exportInclusion === false ||
        (f as unknown as Record<string, unknown>).exportInclusion === false
      ) {
        return true
      }
      return false
    })
    counts.excludedFeatures = excludedFeaturesList.length
    counts.includedFeatures = Math.max(0, counts.totalFeatures - counts.excludedFeatures)

    // Exclusions
    const exclusionsList: string[] = []
    for (const [k, v] of Object.entries(activeInclusions)) {
      if (!v && !exclusionsList.includes(k)) {
        exclusionsList.push(k)
      }
    }

    // Explicit modeling and generation assumptions
    const assumptionsList = options?.assumptions ?? [
      'Authoritative horizontal footprints: Road, facility, and junction polygons define mesh footprints.',
      'Elevation and extrusion skirts: Godot adds terrain elevation, vertical extrusion skirts, materials, and trimesh collisions without altering horizontal geometry.',
      'Road centerlines and profiles retained as semantic data without conflicting footprint regeneration.',
      facilityInferencePolicy.value === 'none'
        ? "Facility inference policy: 'none'. Sidewalks and cycling facilities are not inferred or invented solely because a road exists."
        : `Facility inference policy: '${facilityInferencePolicy.value}'. Missing facilities are inferred under active policy.`,
      'Road widths: Explicit widths from edits/tags take precedence; unmeasured roads use default standard widths with provenance tracking.',
      'Building heights: Explicit heights/levels take precedence; unmeasured buildings assume default 8.0m (2 levels).',
      `Projection: Local equirectangular tangent plane centered at [${project.value.projectionOrigin.lon.toFixed(6)}, ${project.value.projectionOrigin.lat.toFixed(6)}] with +East (X), +North (Y 2D / -Z Godot).`,
      `Export clipping policy: ${typeof activeClippingPolicy === 'object' ? JSON.stringify(activeClippingPolicy) : activeClippingPolicy}.`
    ]

    // Blocking geometry errors (checked strictly on included features)
    const blockingErrors = findProjectBlockingGeometryErrors(project.value.features, activeInclusions)

    const canGenerate = blockingErrors.length === 0 && counts.includedFeatures > 0 && counts.totalSurfaces > 0

    const srcMeta = project.value.sourceMetadata || { source: 'custom' }
    const sourceKind = (srcMeta.source || 'custom') as 'osm' | 'overture' | 'custom'
    const defaultAttribution =
      sourceKind === 'overture'
        ? 'Overture Maps Foundation, © OpenStreetMap contributors'
        : sourceKind === 'osm'
          ? '© OpenStreetMap contributors'
          : 'Custom Dataset'
    const defaultLicense =
      sourceKind === 'overture'
        ? 'CDLA-Permissive-2.0'
        : sourceKind === 'osm'
          ? 'ODbL-1.0'
          : 'Unspecified'

    const attributionText = srcMeta.attribution || defaultAttribution
    const primaryLicense = srcMeta.license || defaultLicense
    const allLicenses = srcMeta.licenses && srcMeta.licenses.length > 0 ? srcMeta.licenses : [primaryLicense]
    const allAttributions = srcMeta.attributions && srcMeta.attributions.length > 0 ? srcMeta.attributions : [attributionText]
    const structuredSources =
      srcMeta.sourceAttributions && srcMeta.sourceAttributions.length > 0
        ? srcMeta.sourceAttributions
        : [
            {
              dataset: sourceKind === 'overture' ? 'Overture Maps Foundation' : sourceKind === 'osm' ? 'OpenStreetMap' : 'Custom',
              attribution: attributionText,
              license: primaryLicense
            }
          ]

    return {
      canGenerate,
      counts,
      exclusions: {
        hasExclusions: exclusionsList.length > 0 || counts.excludedFeatures > 0,
        categories: exclusionsList,
        items: exportSummary.value.exclusions,
        totalExcluded: counts.excludedFeatures
      },
      assumptions: assumptionsList,
      blockingErrors,
      warnings: project.value.warnings ? [...project.value.warnings] : [],
      attribution: {
        source: sourceKind,
        attribution: attributionText,
        attributions: allAttributions,
        license: primaryLicense,
        licenses: allLicenses,
        sourceAttributions: structuredSources
      }
    }
  }

  const sceneExportPreflight = computed<SceneExportPreflight>(() => getSceneExportPreflight())

  function exportEditorGodotPayload(options?: {
    inclusions?: Record<string, boolean>
    clippingPolicy?: ExportClippingPolicy
    assumptions?: string[]
    includeSemanticCenterlines?: boolean
    strict?: boolean
    validateBlocking?: boolean
  }): EditorGodotPayload {
    const activeInclusions = options?.inclusions ?? exportInclusions.value
    const activeClippingPolicy = options?.clippingPolicy ?? exportClippingPolicy.value

    const blockingErrors = findProjectBlockingGeometryErrors(project.value.features, activeInclusions)
    if ((options?.strict || options?.validateBlocking) && blockingErrors.length > 0) {
      throw new Error(
        `Cannot generate scene payload: ${blockingErrors.length} blocking geometry error(s) detected: ${blockingErrors.map((e) => `[${e.featureId}] ${e.message}`).join('; ')}`
      )
    }

    // 1. Authoritative horizontal surfaces generated in realistic view mode
    const surfaces = generateViewSurfaces(
      project.value.features,
      'realistic',
      project.value.projectionOrigin,
      junctionGraph.value
    )

    const featureMap = new Map<string, EditorFeature>()
    for (const f of project.value.features) {
      featureMap.set(f.id, f)
    }

    // 2. Filter by export inclusions
    const includedSurfaces = surfaces.filter((surface) => {
      const cat = mapKindToCategory(surface.kind, surface.role)
      if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
        return false
      }
      if (surface.properties?.exportInclusion === false) {
        return false
      }
      const parent = surface.parentFeatureId ? featureMap.get(surface.parentFeatureId) : undefined
      if (parent && (parent.properties?.exportInclusion === false || (parent as unknown as Record<string, unknown>).exportInclusion === false)) {
        return false
      }
      return (
        activeInclusions[cat] !== false &&
        activeInclusions[surface.kind ?? ''] !== false &&
        activeInclusions[surface.role ?? ''] !== false
      )
    })

    // 3. Apply export clipping
    const { surfaces: clippedSurfaces, stats } = applyExportClippingToSurfaces(
      includedSurfaces,
      project.value.selectedBounds,
      project.value.projectionOrigin,
      activeClippingPolicy
    )


    const counts = {
      total: 0,
      roads: 0,
      buildings: 0,
      sidewalks: 0,
      bikeLanes: 0,
      junctions: 0,
      unsupported: 0
    }

    const exportFeatures: EditorExportFeature[] = []

    for (const surface of clippedSurfaces) {
      // Validate generated surface geometry
      const geomVal = validateGeometryStructure(surface.geometry)
      if (!geomVal.valid) {
        continue
      }

      const parent = surface.parentFeatureId ? featureMap.get(surface.parentFeatureId) : undefined
      const effectiveRole: FeatureRole = surface.role ?? (parent ? (parent.role ?? parent.kind) : 'unsupported')

      if (effectiveRole === 'carriageway' || effectiveRole === 'road') counts.roads++
      else if (effectiveRole === 'building') counts.buildings++
      else if (effectiveRole === 'sidewalk') counts.sidewalks++
      else if (effectiveRole === 'bike_lane' || effectiveRole === 'cycleway' || effectiveRole === 'bike_facility') counts.bikeLanes++
      else if (effectiveRole === 'junction') counts.junctions++
      else counts.unsupported++
      counts.total++

      const effectiveCenterline =
        parent?.effectiveGeometry?.type === 'LineString'
          ? parent.effectiveGeometry
          : parent?.sourceGeometry?.type === 'LineString'
            ? parent.sourceGeometry
            : undefined

      exportFeatures.push({
        type: 'Feature',
        id: surface.id,
        geometry: surface.geometry,
        properties: {
          id: surface.id,
          parentFeatureId: surface.parentFeatureId,
          stripId: surface.stripId,
          role: effectiveRole,
          kind: surface.kind ?? effectiveRole,
          isPolygon: surface.geometry.type === 'Polygon' || surface.geometry.type === 'MultiPolygon',
          isFootprintAuthority: true,
          side: surface.properties?.side,
          direction: surface.properties?.direction,
          lateralPlacement: surface.properties?.lateralPlacement,
          coordinateOrderConvention: 'left_right_relative_to_source_coordinates',
          widthMeters: surface.properties?.widthMeters !== undefined
            ? surface.properties.widthMeters
            : (parent?.roadProfile?.carriagewayWidthMeters?.value !== undefined
              ? parent.roadProfile.carriagewayWidthMeters.value
              : parent?.roadProfile?.widthMeters?.value),
          heightMeters: surface.properties?.heightMeters !== undefined
            ? surface.properties.heightMeters
            : parent?.buildingProfile?.heightMeters?.value,
          levels: surface.properties?.levels !== undefined
            ? surface.properties.levels
            : parent?.buildingProfile?.levels?.value,
          surface: surface.properties?.surface,
          layer: parent ? getFeatureEffectiveLayer(parent) : ((surface.properties?.layer as number) ?? 0),
          bridge: Boolean(parent?.roadProfile?.bridge ?? parent?.properties?.bridge),
          tunnel: Boolean(parent?.roadProfile?.tunnel ?? parent?.properties?.tunnel),
          roadProfile: parent?.roadProfile ? JSON.parse(JSON.stringify(parent.roadProfile)) : undefined,
          buildingProfile: parent?.buildingProfile ? JSON.parse(JSON.stringify(parent.buildingProfile)) : undefined,
          centerline: effectiveCenterline ? JSON.parse(JSON.stringify(effectiveCenterline)) : undefined,
          sidewalk: parent?.roadProfile?.sidewalks?.presence === 'absent' ? 'no' : (surface.properties?.sidewalk as string | undefined),
          cycleway: parent?.roadProfile?.cycleFacilities?.presence === 'absent' ? 'no' : (surface.properties?.cycleway as string | undefined),
          provenance: (surface.properties?.provenance as Provenance) ?? parent?.roadProfile?.widthMeters?.provenance,
          isInferredWidth: Boolean(surface.properties?.isInferredWidth),
          isInferredFacility: Boolean(surface.properties?.isInferredFacility),
          isClipped: surface.properties?.isClipped,
          boundaryRelation: surface.properties?.boundaryRelation,
          sourceTags: parent?.sourceTags,
          sourceProperties: parent?.properties,
          ...surface.properties
        }
      })
    }

    if (options?.includeSemanticCenterlines) {
      for (const f of project.value.features) {
        if (f.kind !== 'road' && f.kind !== 'bike_facility' && f.kind !== 'sidewalk') continue
        const cat = mapKindToCategory(f.kind, f.role)
        if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
          continue
        }
        if (activeInclusions[cat] === false || activeInclusions[f.kind] === false || activeInclusions[f.role ?? ''] === false) {
          continue
        }
        if (f.properties?.exportInclusion === false || (f as unknown as Record<string, unknown>).exportInclusion === false) {
          continue
        }
        const geom =
          f.effectiveGeometry?.type === 'LineString'
            ? f.effectiveGeometry
            : f.sourceGeometry?.type === 'LineString'
              ? f.sourceGeometry
              : undefined
        if (!geom) continue

        const geomVal = validateGeometryStructure(geom)
        if (!geomVal.valid) continue

        const centerProps: Record<string, unknown> = {
          id: `${f.id}_centerline`,
          parentFeatureId: f.id,
          role: 'centerline',
          kind: 'centerline',
          isPolygon: false,
          isFootprintAuthority: false,
          isSemanticCenterline: true,
          roadProfile: f.roadProfile ? JSON.parse(JSON.stringify(f.roadProfile)) : undefined,
          sourceTags: f.sourceTags,
          sourceProperties: f.properties,
          layer: getFeatureEffectiveLayer(f)
        }
        if (f.roadProfile?.sidewalks?.presence === 'absent') {
          centerProps.sidewalk = 'no'
        }
        if (f.roadProfile?.cycleFacilities?.presence === 'absent') {
          centerProps.cycleway = 'no'
        }

        exportFeatures.push({
          type: 'Feature',
          id: `${f.id}_centerline`,
          geometry: geom,
          properties: centerProps
        })
      }
    }
    const exclusionsList: string[] = []
    for (const [k, v] of Object.entries(activeInclusions)) {
      if (!v && !exclusionsList.includes(k)) {
        exclusionsList.push(k)
      }
    }

    const assumptionsList = options?.assumptions ?? [
      'Authoritative horizontal footprints: Road, facility, and junction polygons define mesh footprints.',
      'Elevation and extrusion skirts: Godot adds terrain elevation, vertical extrusion skirts, materials, and trimesh collisions without altering horizontal geometry.',
      'Road centerlines and profiles retained as semantic data without conflicting footprint regeneration.',
      facilityInferencePolicy.value === 'none'
        ? "Facility inference policy: 'none'. Sidewalks and cycling facilities are not inferred or invented solely because a road exists."
        : `Facility inference policy: '${facilityInferencePolicy.value}'. Missing facilities are inferred under active policy.`,
      'Road widths: Explicit widths from edits/tags take precedence; unmeasured roads use default standard widths with provenance tracking.',
      'Building heights: Explicit heights/levels take precedence; unmeasured buildings assume default 8.0m (2 levels).',
      `Projection: Local equirectangular tangent plane centered at [${project.value.projectionOrigin.lon.toFixed(6)}, ${project.value.projectionOrigin.lat.toFixed(6)}] with +East (X), +North (Y 2D / -Z Godot).`,
      `Export clipping policy: ${typeof activeClippingPolicy === 'object' ? JSON.stringify(activeClippingPolicy) : activeClippingPolicy}.`
    ]

    const srcMeta = JSON.parse(JSON.stringify(project.value.sourceMetadata || { source: 'custom' }))
    const sourceKind = (srcMeta.source || 'custom') as 'osm' | 'overture' | 'custom'
    const defaultAttribution =
      sourceKind === 'overture'
        ? 'Overture Maps Foundation, © OpenStreetMap contributors'
        : sourceKind === 'osm'
          ? '© OpenStreetMap contributors'
          : 'Custom Dataset'
    const defaultLicense =
      sourceKind === 'overture'
        ? 'CDLA-Permissive-2.0'
        : sourceKind === 'osm'
          ? 'ODbL-1.0'
          : 'Unspecified'

    const attributionText = srcMeta.attribution || defaultAttribution
    const primaryLicense = srcMeta.license || defaultLicense
    const allLicenses = srcMeta.licenses && srcMeta.licenses.length > 0 ? srcMeta.licenses : [primaryLicense]
    const allAttributions = srcMeta.attributions && srcMeta.attributions.length > 0 ? srcMeta.attributions : [attributionText]
    const structuredSources =
      srcMeta.sourceAttributions && srcMeta.sourceAttributions.length > 0
        ? srcMeta.sourceAttributions
        : [
            {
              dataset: sourceKind === 'overture' ? 'Overture Maps Foundation' : sourceKind === 'osm' ? 'OpenStreetMap' : 'Custom',
              attribution: attributionText,
              license: primaryLicense
            }
          ]

    srcMeta.attribution = attributionText
    srcMeta.attributions = allAttributions
    srcMeta.license = primaryLicense
    srcMeta.licenses = allLicenses
    srcMeta.sourceAttributions = structuredSources

    const metadata: EditorExportMetadata = {
      generator: 'osm-to-godot-editor',
      version: CURRENT_EDITOR_PAYLOAD_VERSION,
      exportedAt: new Date().toISOString(),
      sourceMetadata: srcMeta,
      attribution: attributionText,
      attributions: allAttributions,
      license: primaryLicense,
      licenses: allLicenses,
      sourceAttributions: structuredSources,
      projectionOrigin: { ...project.value.projectionOrigin },
      projection: {
        type: 'equirectangular_local_tangent',
        earthRadius: 6378137.0,
        origin: { ...project.value.projectionOrigin },
        axes: {
          x: '+East (meters)',
          y: '+North (meters 2D tangent plane, +Up in Godot 3D)',
          z: '-North (meters in Godot 3D)'
        },
        unit: 'meter'
      },
      selectedBounds: project.value.selectedBounds ? [...project.value.selectedBounds] : undefined,
      exportInclusions: { ...activeInclusions },
      featureCounts: counts,
      exclusions: exclusionsList,
      assumptions: assumptionsList,
      warnings: project.value.warnings ? [...project.value.warnings] : [],
      clippingPolicy: stats.policyApplied,
      blockingErrors
    }

    return {
      type: 'FeatureCollection',
      generator: 'osm-to-godot-editor',
      editorPayloadVersion: CURRENT_EDITOR_PAYLOAD_VERSION,
      metadata,
      attribution: attributionText,
      license: primaryLicense,
      projectionOrigin: { ...project.value.projectionOrigin },
      projection: metadata.projection,
      clippingPolicy: stats.policyApplied,
      clippingStats: stats,
      features: exportFeatures
    }
  }

  function exportSurfacesGeoJSON(options?: {
    inclusions?: Record<string, boolean>
    viewMode?: ViewMode
    clippingPolicy?: ExportClippingPolicy
  }): GeoJSON.FeatureCollection {
    if (!options?.viewMode || options.viewMode === 'realistic') {
      return exportEditorGodotPayload(options) as unknown as GeoJSON.FeatureCollection
    }
    const activeInclusions = options?.inclusions ?? exportInclusions.value
    const targetMode = options.viewMode
    const activeClippingPolicy = options?.clippingPolicy ?? exportClippingPolicy.value
    const surfaces = generateViewSurfaces(
      project.value.features,
      targetMode,
      project.value.projectionOrigin,
      junctionGraph.value
    )
    const includedSurfaces = surfaces.filter((surface) => {
      const cat = mapKindToCategory(surface.kind, surface.role)
      if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
        return false
      }
      return (
        activeInclusions[cat] !== false &&
        activeInclusions[surface.kind ?? ''] !== false &&
        activeInclusions[surface.role ?? ''] !== false
      )
    })
    const { surfaces: clippedSurfaces, stats } = applyExportClippingToSurfaces(
      includedSurfaces,
      project.value.selectedBounds,
      project.value.projectionOrigin,
      activeClippingPolicy
    )

    const srcMetaNonReal = JSON.parse(JSON.stringify(project.value.sourceMetadata || { source: 'custom' }))
    const nonRealAttr =
      srcMetaNonReal.attribution ||
      (srcMetaNonReal.source === 'overture'
        ? 'Overture Maps Foundation, © OpenStreetMap contributors'
        : '© OpenStreetMap contributors')
    const nonRealLic =
      srcMetaNonReal.license || (srcMetaNonReal.source === 'overture' ? 'CDLA-Permissive-2.0' : 'ODbL-1.0')

    return {
      type: 'FeatureCollection',
      generator: 'osm-to-godot-editor',
      editorPayloadVersion: CURRENT_EDITOR_PAYLOAD_VERSION,
      attribution: nonRealAttr,
      license: nonRealLic,
      metadata: {
        generator: 'osm-to-godot-editor',
        version: CURRENT_EDITOR_PAYLOAD_VERSION,
        exportedAt: new Date().toISOString(),
        sourceMetadata: srcMetaNonReal,
        attribution: nonRealAttr,
        license: nonRealLic
      },
      projectionOrigin: { ...project.value.projectionOrigin },
      projection: {
        type: 'equirectangular_local_tangent',
        earthRadius: 6378137.0,
        origin: { ...project.value.projectionOrigin },
        axes: {
          x: '+East (meters)',
          y: '+North (meters 2D tangent plane, +Up in Godot 3D)',
          z: '-North (meters in Godot 3D)'
        },
        unit: 'meter'
      },
      clippingPolicy: stats.policyApplied,
      clippingStats: stats,
      features: clippedSurfaces.map((surface) => ({
        type: 'Feature',
        id: surface.id,
        geometry: surface.geometry,
        properties: {
          id: surface.id,
          parentFeatureId: surface.parentFeatureId,
          stripId: surface.stripId,
          role: surface.role,
          kind: surface.kind ?? surface.role,
          isPolygon: surface.geometry.type === 'Polygon' || surface.geometry.type === 'MultiPolygon',
          isFootprintAuthority: true,
          side: surface.properties?.side,
          direction: surface.properties?.direction,
          lateralPlacement: surface.properties?.lateralPlacement,
          coordinateOrderConvention: 'left_right_relative_to_source_coordinates',
          viewMode: surface.viewMode,
          isInferredWidth: Boolean(surface.properties?.isInferredWidth),
          isInferredFacility: Boolean(surface.properties?.isInferredFacility),
          isClipped: surface.properties?.isClipped,
          boundaryRelation: surface.properties?.boundaryRelation,
          ...surface.properties
        }
      }))
    } as unknown as GeoJSON.FeatureCollection
  }
  /**
   * Downloads the reopenable editor project as a ProjectEnvelope JSON file.
   * Restores full editing state (source features, active features with edits,
   * edit overrides, editor settings, layer visibilities, export inclusions, and projection metadata).
   * Marks the project clean/saved.
   */
  function downloadProjectFile(customFilename?: string): {
    success: boolean
    filename: string
    envelope: ProjectEnvelope
  } {
    const envelope = saveProjectEnvelope()
    const src = envelope.sourceMetadata?.source || 'custom'
    const filename = customFilename || `project_${src}_${Date.now()}.json`

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const jsonStr = JSON.stringify(envelope, null, 2)
      const blob = new Blob([jsonStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    markSaved()
    return { success: true, filename, envelope }
  }

  /**
   * Downloads the effective edited GeoJSON scene payload (EditorGodotPayload).
   * Contains authoritative horizontal surfaces (roads, junctions, sidewalks, cycleways, buildings with holes),
   * normalized effective properties, explicit feature roles, stable IDs, projection metadata,
   * exclusions, and clipping stats for Godot or GIS tools.
   * Does NOT clear unsaved edits on the editable project.
   */
  function downloadScenePayload(
    customFilename?: string,
    options?: {
      inclusions?: Record<string, boolean>
      clippingPolicy?: ExportClippingPolicy
      assumptions?: string[]
      includeSemanticCenterlines?: boolean
    }
  ): {
    success: boolean
    filename: string
    payload: EditorGodotPayload
  } {
    const payload = exportEditorGodotPayload(options)
    const src = project.value.sourceMetadata?.source || 'custom'
    const filename = customFilename || `editor_scene_${src}_${Date.now()}.geojson`

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const jsonStr = JSON.stringify(payload, null, 2)
      const blob = new Blob([jsonStr], { type: 'application/geo+json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    return { success: true, filename, payload }
  }


  function revertFeatureOverrides(featureId: string): boolean {
    const idx = project.value.features.findIndex((f) => f.id === featureId)
    if (idx === -1) return false
    const sourceFeat = project.value.sourceFeatures?.find((f) => f.id === featureId)
    if (!sourceFeat) return false
    recordSnapshot()
    const restored = cloneFeature(sourceFeat)
    const newFeatures = [...project.value.features]
    newFeatures[idx] = restored
    const newOverrides = { ...(project.value.editOverrides || {}) }
    delete newOverrides[featureId]
    project.value = {
      ...project.value,
      features: newFeatures,
      editOverrides: newOverrides
    }
    isDirty.value = true
    activeGeometryGenerationId++
    getEditorWorkerBridge().cancelPending()
    const stats = recomputeAffectedGeometryImpl(
      geometryCache,
      featureId,
      project.value.features,
      viewMode.value,
      project.value.projectionOrigin,
      junctionGraph.value
    )
    viewSurfaces.value = flattenGeometryCache(geometryCache)
    subordinateSurfaces.value = flattenSubordinateSurfaces(geometryCache)
    lastRecomputationStats.value = stats

    return true
  }
  function revertFeatureProperty(featureId: string, propertyKey: string, subId?: string): boolean {
    const idx = project.value.features.findIndex((f) => f.id === featureId)
    if (idx === -1) return false
    const f = project.value.features[idx]
    const sourceFeat = project.value.sourceFeatures?.find((sf) => sf.id === featureId)
    if (!sourceFeat) return false

    recordSnapshot()

    let changed = false

    if ((propertyKey === 'carriagewayWidth' || propertyKey === 'width') && f.roadProfile && sourceFeat.roadProfile) {
      const srcW = sourceFeat.roadProfile.carriagewayWidthMeters
      if (srcW) {
        f.roadProfile.carriagewayWidthMeters = JSON.parse(JSON.stringify(srcW))
        if (sourceFeat.roadProfile.widthResolutionTier) {
          f.roadProfile.widthResolutionTier = sourceFeat.roadProfile.widthResolutionTier
        }
        recalculateRoadStrips(f.roadProfile)
        changed = true
      }
    } else if (propertyKey === 'direction' && f.roadProfile) {
      f.roadProfile.direction = sourceFeat.roadProfile?.direction || 'both'
      f.roadProfile.oneWay = sourceFeat.roadProfile?.oneWay ?? false
      if (sourceFeat.roadProfile?.strips) {
        for (const st of f.roadProfile.strips) {
          const srcSt = sourceFeat.roadProfile.strips.find((s) => s.id === st.id)
          if (srcSt) st.direction = srcSt.direction
        }
      }
      changed = true
    } else if (propertyKey === 'lanes' && f.roadProfile) {
      f.roadProfile.lanes = sourceFeat.roadProfile?.lanes
        ? JSON.parse(JSON.stringify(sourceFeat.roadProfile.lanes))
        : { value: 2, provenance: 'inferred' }
      f.roadProfile.forwardLanes = sourceFeat.roadProfile?.forwardLanes
      f.roadProfile.backwardLanes = sourceFeat.roadProfile?.backwardLanes
      if (sourceFeat.properties?.lanes !== undefined) {
        f.properties.lanes = sourceFeat.properties.lanes
      } else {
        delete f.properties.lanes
      }
      changed = true
    } else if (propertyKey === 'speedLimit' && f.roadProfile) {
      f.roadProfile.speedLimit = sourceFeat.roadProfile?.speedLimit
        ? JSON.parse(JSON.stringify(sourceFeat.roadProfile.speedLimit))
        : undefined
      if (sourceFeat.properties?.maxspeed !== undefined) {
        f.properties.maxspeed = sourceFeat.properties.maxspeed
      } else {
        delete f.properties.maxspeed
      }
      changed = true
    } else if (propertyKey === 'surface' && f.roadProfile) {
      f.roadProfile.surface = sourceFeat.roadProfile?.surface
        ? JSON.parse(JSON.stringify(sourceFeat.roadProfile.surface))
        : undefined
      if (sourceFeat.properties?.surface !== undefined) {
        f.properties.surface = sourceFeat.properties.surface
      } else {
        delete f.properties.surface
      }
      if (sourceFeat.roadProfile?.strips) {
        for (const st of f.roadProfile.strips) {
          const srcSt = sourceFeat.roadProfile.strips.find((s) => s.id === st.id)
          if (srcSt) st.surface = srcSt.surface
        }
      }
      changed = true
    } else if (propertyKey === 'highway' && f.properties) {
      if (sourceFeat.properties?.highway !== undefined) {
        f.properties.highway = sourceFeat.properties.highway
      } else {
        delete f.properties.highway
      }
      if (f.roadProfile) {
        f.roadProfile.highwayClass = (sourceFeat.properties?.highway as string) || sourceFeat.roadProfile?.highwayClass || 'unclassified'
      }
      changed = true
    } else if (propertyKey === 'sidewalks' && f.roadProfile) {
      f.roadProfile.sidewalks = sourceFeat.roadProfile?.sidewalks
        ? JSON.parse(JSON.stringify(sourceFeat.roadProfile.sidewalks))
        : undefined
      if (f.roadProfile?.cycleFacilities?.provenance !== 'user_edited' && sourceFeat.roadProfile?.strips) {
        f.roadProfile.strips = JSON.parse(JSON.stringify(sourceFeat.roadProfile.strips))
        f.roadProfile.totalCorridorWidthMeters = sourceFeat.roadProfile.totalCorridorWidthMeters
      } else {
        f.roadProfile.strips = f.roadProfile.strips.filter((s) => s.kind !== 'sidewalk')
        recalculateRoadStrips(f.roadProfile)
      }
      changed = true
    } else if (propertyKey === 'cycleFacilities' && f.roadProfile) {
      f.roadProfile.cycleFacilities = sourceFeat.roadProfile?.cycleFacilities
        ? JSON.parse(JSON.stringify(sourceFeat.roadProfile.cycleFacilities))
        : undefined
      if (f.roadProfile?.sidewalks?.provenance !== 'user_edited' && sourceFeat.roadProfile?.strips) {
        f.roadProfile.strips = JSON.parse(JSON.stringify(sourceFeat.roadProfile.strips))
        f.roadProfile.totalCorridorWidthMeters = sourceFeat.roadProfile.totalCorridorWidthMeters
      } else {
        f.roadProfile.strips = f.roadProfile.strips.filter((s) => s.kind !== 'bike_lane')
        recalculateRoadStrips(f.roadProfile)
      }
      changed = true
    } else if (propertyKey === 'strips' && f.roadProfile) {
      if (subId) {
        const srcStrip = sourceFeat.roadProfile?.strips?.find((s) => s.id === subId)
        const curStrip = f.roadProfile.strips.find((s) => s.id === subId)
        if (srcStrip && curStrip) {
          curStrip.widthMeters = srcStrip.widthMeters
          curStrip.provenance = srcStrip.provenance
          recalculateRoadStrips(f.roadProfile)
          changed = true
        }
        f.roadProfile.totalCorridorWidthMeters = sourceFeat.roadProfile.totalCorridorWidthMeters
        changed = true
      }
    } else if (propertyKey === 'buildingLevels' && f.buildingProfile) {
      f.buildingProfile.levels = sourceFeat.buildingProfile?.levels
        ? JSON.parse(JSON.stringify(sourceFeat.buildingProfile.levels))
        : undefined
      if (sourceFeat.properties?.['building:levels'] !== undefined) {
        f.properties['building:levels'] = sourceFeat.properties['building:levels']
      } else {
        delete f.properties['building:levels']
      }
      if (f.buildingProfile.heightMeters?.provenance !== 'user_edited' && sourceFeat.buildingProfile?.heightMeters) {
        f.buildingProfile.heightMeters = JSON.parse(JSON.stringify(sourceFeat.buildingProfile.heightMeters))
      }
      changed = true
    } else if (propertyKey === 'buildingHeight' && f.buildingProfile) {
      f.buildingProfile.heightMeters = sourceFeat.buildingProfile?.heightMeters
        ? JSON.parse(JSON.stringify(sourceFeat.buildingProfile.heightMeters))
        : undefined
      if (sourceFeat.properties?.height !== undefined) {
        f.properties.height = sourceFeat.properties.height
      } else {
        delete f.properties.height
      }
      changed = true
    } else if (propertyKey === 'geometry') {
      f.effectiveGeometry = undefined
      changed = true
    }

    if (!changed) {
      undoStack.value.pop()
      return false
    }

    const hasRemainingOverrides =
      f.roadProfile?.carriagewayWidthMeters?.provenance === 'user_edited' ||
      f.roadProfile?.lanes?.provenance === 'user_edited' ||
      f.roadProfile?.speedLimit?.provenance === 'user_edited' ||
      f.roadProfile?.surface?.provenance === 'user_edited' ||
      f.roadProfile?.sidewalks?.provenance === 'user_edited' ||
      f.roadProfile?.cycleFacilities?.provenance === 'user_edited' ||
      Boolean(f.roadProfile?.strips?.some((s) => s.provenance === 'user_edited')) ||
      (Boolean(f.roadProfile) && (f.roadProfile?.direction || 'both') !== (sourceFeat.roadProfile?.direction || 'both')) ||
      f.buildingProfile?.levels?.provenance === 'user_edited' ||
      f.buildingProfile?.heightMeters?.provenance === 'user_edited' ||
      Boolean(f.effectiveGeometry) ||
      (f.properties && JSON.stringify(f.properties) !== JSON.stringify(sourceFeat.properties))

    const newOverrides = { ...(project.value.editOverrides || {}) }
    if (!hasRemainingOverrides) {
      delete newOverrides[featureId]
      project.value.features[idx] = cloneFeature(sourceFeat)
    } else {
      newOverrides[featureId] = {
        featureId,
        effectiveGeometry: f.effectiveGeometry ? JSON.parse(JSON.stringify(f.effectiveGeometry)) : undefined,
        roadProfile: f.roadProfile ? JSON.parse(JSON.stringify(f.roadProfile)) : undefined,
        buildingProfile: f.buildingProfile ? JSON.parse(JSON.stringify(f.buildingProfile)) : undefined,
        properties: JSON.parse(JSON.stringify(f.properties))
      }
    }
    project.value = {
      ...project.value,
      editOverrides: newOverrides
    }
    isDirty.value = true
    activeGeometryGenerationId++
    getEditorWorkerBridge().cancelPending()
    const stats = recomputeAffectedGeometryImpl(
      geometryCache,
      featureId,
      project.value.features,
      viewMode.value,
      project.value.projectionOrigin,
      junctionGraph.value
    )
    viewSurfaces.value = flattenGeometryCache(geometryCache)
    subordinateSurfaces.value = flattenSubordinateSurfaces(geometryCache)
    lastRecomputationStats.value = stats

    return true
  }


  function revertAllOverrides(): boolean {
    if (!project.value.sourceFeatures || project.value.sourceFeatures.length === 0) {
      return false
    }
    recordSnapshot()
    project.value = {
      ...project.value,
      features: cloneFeatureCollection(project.value.sourceFeatures),
      editOverrides: {}
    }
    isDirty.value = true
    activeGeometryGenerationId++
    getEditorWorkerBridge().cancelPending()
    rebuildAllSurfaces()
    return true
  }

  function undo(): boolean {
    if (undoStack.value.length === 0) return false
    endContinuousAdjustment()
    const prev = undoStack.value.pop()!
    redoStack.value.push({
      features: cloneFeatureCollection(project.value.features),
      editOverrides: JSON.parse(JSON.stringify(project.value.editOverrides || {})),
      exportInclusions: JSON.parse(JSON.stringify(exportInclusions.value)),
      groupKey: prev.groupKey,
      version: currentVersion
    })
    project.value = {
      ...project.value,
      features: prev.features,
      editOverrides: prev.editOverrides
    }
    if (prev.exportInclusions) {
      exportInclusions.value = { ...prev.exportInclusions }
      if (!project.value.editorSettings) {
        project.value.editorSettings = {}
      }
      project.value.editorSettings.exportInclusions = { ...prev.exportInclusions }
    }
    currentVersion = prev.version ?? (undoStack.value.length === 0 ? 0 : currentVersion - 1)
    isDirty.value = currentVersion !== savedVersion
    rebuildAllSurfaces()
    if (selectedFeatureId.value) {
      const match = viewSurfaces.value.find(
        (s) => s.parentFeatureId === selectedFeatureId.value && (!selectedStripId.value || s.stripId === selectedStripId.value)
      )
      selectedSurfaceId.value = match?.id ?? null
    }
    return true
  }

  function redo(): boolean {
    if (redoStack.value.length === 0) return false
    endContinuousAdjustment()
    const next = redoStack.value.pop()!
    undoStack.value.push({
      features: cloneFeatureCollection(project.value.features),
      editOverrides: JSON.parse(JSON.stringify(project.value.editOverrides || {})),
      exportInclusions: JSON.parse(JSON.stringify(exportInclusions.value)),
      groupKey: next.groupKey,
      version: currentVersion
    })
    project.value = {
      ...project.value,
      features: next.features,
      editOverrides: next.editOverrides
    }
    if (next.exportInclusions) {
      exportInclusions.value = { ...next.exportInclusions }
      if (!project.value.editorSettings) {
        project.value.editorSettings = {}
      }
      project.value.editorSettings.exportInclusions = { ...next.exportInclusions }
    }
    currentVersion = next.version ?? (currentVersion + 1)
    isDirty.value = currentVersion !== savedVersion
    rebuildAllSurfaces()
    if (selectedFeatureId.value) {
      const match = viewSurfaces.value.find(
        (s) => s.parentFeatureId === selectedFeatureId.value && (!selectedStripId.value || s.stripId === selectedStripId.value)
      )
      selectedSurfaceId.value = match?.id ?? null
    }
    return true
  }

  function markSaved() {
    savedVersion = currentVersion
    isDirty.value = false
  }
  function confirmLeaveProject(actionName: string = 'leave'): boolean {
    if (!isDirty.value) {
      return true
    }
    const confirmFn = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm
      : typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function'
        ? globalThis.confirm
        : undefined
    if (!confirmFn) {
      return true
    }
    return confirmFn(`You have unsaved edits in the active project. ${actionName.charAt(0).toUpperCase() + actionName.slice(1)} anyway?`)
  }


  function selectFeature(id: string | null, stripId?: string | null) {
    if (!id) {
      selectedFeatureId.value = null
      selectedStripId.value = null
      selectedSurfaceId.value = null
      return
    }
    const feat = project.value.features.find((f) => f.id === id)
    if (feat && !isHitTestable(feat.kind, feat.role)) {
      return
    }
    if (!feat) {
      const junc = junctionGraph.value?.getJunction(id)
      if (junc && !isHitTestable('junction', 'junction')) {
        return
      }
    }
    if (stripId) {
      const surf = viewSurfaces.value.find(
        (s) => s.parentFeatureId === id && s.stripId === stripId
      )
      if (surf && !isHitTestable(surf.kind, surf.role)) {
        return
      }
      const stripObj = feat?.roadProfile?.strips?.find((s) => s.id === stripId)
      if (stripObj && !isHitTestable(stripObj.kind)) {
        return
      }
      selectedFeatureId.value = id
      selectedStripId.value = stripId
      selectedSurfaceId.value = surf?.id ?? null
    } else {
      selectedFeatureId.value = id
      selectedStripId.value = null
      const surf = viewSurfaces.value.find((s) => s.parentFeatureId === id)
      selectedSurfaceId.value = surf?.id ?? null
    }
  }

  function selectStrip(stripId: string | null) {
    if (!stripId) {
      selectedStripId.value = null
      return
    }
    if (selectedFeatureId.value) {
      const surf = viewSurfaces.value.find(
        (s) => s.parentFeatureId === selectedFeatureId.value && s.stripId === stripId
      )
      if (surf && !isHitTestable(surf.kind, surf.role)) {
        return
      }
      const feat = project.value.features.find((f) => f.id === selectedFeatureId.value)
      const stripObj = feat?.roadProfile?.strips?.find((s) => s.id === stripId)
      if (stripObj && !isHitTestable(stripObj.kind)) {
        return
      }
      selectedStripId.value = stripId
      if (surf) {
        selectedSurfaceId.value = surf.id
      }
    } else {
      selectedStripId.value = stripId
    }
  }

  function selectSurface(surfaceId: string | null): {
    feature: EditorFeature | null
    strip: CrossSectionStrip | null
    surface: ViewSurface | null
  } | null {
    if (!surfaceId) {
      selectedSurfaceId.value = null
      selectedFeatureId.value = null
      selectedStripId.value = null
      return null
    }
    const surf = viewSurfaces.value.find((s) => s.id === surfaceId)
    if (surf) {
      if (!isHitTestable(surf.kind, surf.role)) {
        return null
      }
      selectedSurfaceId.value = surf.id
      selectedFeatureId.value = surf.parentFeatureId
      selectedStripId.value = surf.stripId ?? null
      return {
        feature: selectedFeature.value,
        strip: selectedStrip.value,
        surface: surf
      }
    }
    // If not matching a surface ID, check if it's a feature ID
    const feat = project.value.features.find((f) => f.id === surfaceId)
    if (feat) {
      if (!isHitTestable(feat.kind, feat.role)) {
        return null
      }
      selectFeature(feat.id)
      return {
        feature: feat,
        strip: null,
        surface: null
      }
    }
    return null
  }

  return {
    project,
    activeSource,
    viewMode,
    selectedFeatureId,
    selectedFeature,
    selectedStripId,
    selectedStrip,
    selectedSurfaceId,
    selectedSurface,
    hoveredFeatureId,
    hoveredSurfaceId,
    hoveredFeature,
    setHoveredFeature,
    viewSurfaces,
    junctionGraph,
    surfacesGeoJSON,
    isDirty,
    lastImportValidation,
    lastImportError,
    actionableImportAdvice,
    categoryCounts,
    categoryAvailability,
    getCategoryExplanation,
    isImporting,
    importProgress,
    isGeneratingGeometry,
    setImportProgress,
    setViewMode,
    setProject,
    updateFeature,
    updateCarriagewayWidth,
    updateBuildingHeight,
    updateBuildingLevels,
    updateRoadLanes,
    updateRoadDirection,
    updateRoadSurface,
    updateRoadSpeedLimit,
    updateRoadHighwayClass,
    updateStripWidth,
    updateRoadSidewalks,
    updateRoadCycleFacilities,
    reverseRoadGeometry,
    saveProjectEnvelope,
    exportProjectEnvelope,
    updateFeatureGeometry,
    revertAllOverrides,
    revertFeatureOverrides,
    revertFeatureProperty,
    markSaved,
    confirmLeaveProject,
    handleBeforeUnload,
    selectFeature,
    selectStrip,
    selectSurface,
    layerVisibility,
    exportInclusions,
    isLayerVisible,
    isHitTestable,
    setLayerVisibility,
    toggleLayerVisibility,
    isExportIncluded,
    setExportInclusion,
    toggleExportInclusion,
    resetExportInclusions,
    exportSummary,
    exportEditorGodotPayload,
    exportSurfacesGeoJSON,
    downloadProjectFile,
    downloadScenePayload,
    canUndo,
    canRedo,
    undo,
    redo,
    clearHistory,
    beginContinuousAdjustment,
    endContinuousAdjustment,
    isContinuousAdjustmentActive,
    computeDrawOrder,
    getFeatureEffectiveLayer,
    areFeaturesGradeSeparated,
    canJoinAtCrossing,
    doFeaturesIntersect2D,
    facilityInferencePolicy,
    setFacilityInferencePolicy,
    exportClippingPolicy,
    setExportClippingPolicy,
    lastRecomputationStats,
    recomputeAffectedGeometry: (featureId: string) =>
      recomputeAffectedGeometryImpl(
        geometryCache,
        featureId,
        project.value.features,
        viewMode.value,
        project.value.projectionOrigin,
        junctionGraph.value
      ),
    rebuildAllSurfaces,
    getSceneExportPreflight,
    sceneExportPreflight,
    findFeatureBlockingGeometryErrors,
    findProjectBlockingGeometryErrors,
  }
}
