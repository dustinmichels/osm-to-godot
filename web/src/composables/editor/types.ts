/**
 * Core types for the 2D Browser Editor.
 *
 * Implements Section 1 ("What data view and realistic view mean") & Section 4 ("Canonical editor data model")
 * principles:
 * - One editable model behind both data view and realistic view
 * - Non-destructive view switching (source geometry is never overwritten)
 * - Source reference line retained even when asymmetric
 * - Carriageway width separated from total corridor width
 * - Local metric projection for offsets (meters, never degrees)
 * - Render physical polygons rather than relying on screen-pixel line thickness
 * - Mark inferred widths and facilities with explicit provenance
 * - Keep source polygons as polygons (no unnecessary centerline derivation)
 */
export interface CameraChangePayload {
  center: [number, number]
  zoom: number
}

export type SemanticKind =
  | 'building'
  | 'road'
  | 'carriageway'
  | 'sidewalk'
  | 'bike_facility'
  | 'bike_lane'
  | 'cycleway'
  | 'junction'
  | 'centerline'
  | 'unsupported'
export type FeatureRole = SemanticKind
export type Provenance =
  | 'source'
  | 'source_provided'
  | 'inferred'
  | 'user_override'
  | 'user_edited'
export type WidthResolutionTier =
  | 'user_override'
  | 'explicit_measurement'
  | 'lane_interpretation'
  | 'class_default'

export type GeometryJoinType = 'miter' | 'square' | 'bevel' | 'round'
export type GeometryEndType = 'butt' | 'square' | 'round' | 'joined' | 'polygon'

export interface ProvenanceValue<T> {
  value: T
  provenance: Provenance
  raw?: unknown
  unit?: string
  parsedStatus?: 'valid' | 'missing' | 'malformed' | 'explicit_zero' | 'explicit_negative'
}

export function formatProvenanceLabel(provenance?: Provenance): 'Source' | 'Inferred' | 'User Edited' {
  if (provenance === 'user_edited' || provenance === 'user_override') return 'User Edited'
  if (provenance === 'inferred') return 'Inferred'
  return 'Source'
}

export function createProvenanceValue<T>(
  value: T,
  provenance: Provenance = 'source',
  unit?: string,
  raw?: unknown,
  parsedStatus?: 'valid' | 'missing' | 'malformed' | 'explicit_zero' | 'explicit_negative'
): ProvenanceValue<T> {
  return {
    value,
    provenance,
    unit,
    raw,
    parsedStatus: parsedStatus || (value !== undefined && value !== null ? 'valid' : 'missing')
  }
}

export interface ParsedDimension {
  status: 'valid' | 'missing' | 'malformed' | 'explicit_zero' | 'explicit_negative'
  value?: number
  unit?: 'm' | 'km' | 'cm' | 'mm' | 'mi' | 'ft' | 'in' | 'yd' | 'mph' | 'km/h' | 'knots' | 'none'
  raw?: unknown
}

export type FacilitySide = 'left' | 'right' | 'both' | 'none' | 'unknown'
export type FacilityPresence = 'present' | 'absent' | 'unknown' | 'separate'

export type FacilityInferencePolicy =
  | 'none'
  | 'urban_defaults'
  | 'pedestrian_and_cycling'

export interface FacilityPresenceDetails {
  presence: FacilityPresence
  left: boolean
  right: boolean
  leftPresence?: FacilityPresence
  rightPresence?: FacilityPresence
  provenance: Provenance
  leftWidthMeters?: number
  rightWidthMeters?: number
  sourceEvidence?: string
  inferencePolicy?: FacilityInferencePolicy
  inferenceReason?: string
  isSeparate?: boolean
  associatedFacilities?: AssociatedSeparateFacility[]
}

export interface CycleFacilityPresenceDetails extends FacilityPresenceDetails {
  kind?: 'lane' | 'track' | 'shared' | 'none'
  leftCycleKind?: 'lane' | 'track' | 'shared' | 'none'
  rightCycleKind?: 'lane' | 'track' | 'shared' | 'none'
}

export interface AssociatedSeparateFacility {
  featureId: string
  kind: 'sidewalk' | 'cycleway'
  side: 'left' | 'right' | 'uncertain'
  distanceMeters: number
  confidence: 'high' | 'uncertain'
  reason?: string
}
export interface LateralPlacement {
  /**
   * Lateral center offset relative to the source line coordinate order (negative = left, positive = right).
   * Left and right are strictly defined relative to the way's source coordinate sequence (from first to last vertex).
   */
  offsetMeters: number
  innerOffsetMeters: number // lateral offset of edge closer to source line
  outerOffsetMeters: number // lateral offset of edge farther from source line
  orderIndex: number // 0-based position from left to right across the cross-section
}

export interface CrossSectionStrip {
  id: string
  kind: 'carriageway' | 'sidewalk' | 'bike_lane' | 'buffer' | 'median' | 'parking' | 'cycleway'
  facilityKind?: 'lane' | 'track' | 'shared' | 'none'
  /**
   * Lateral side strictly defined relative to the source coordinate order:
   * 'left' is to the left (+90 deg normal), 'right' is to the right (-90 deg normal).
   * Preserved through travel direction changes and exports.
   */
  side?: 'left' | 'right' | 'center'
  widthMeters: number
  width?: ProvenanceValue<number>
  provenance?: Provenance
  direction?: 'forward' | 'backward' | 'both'
  surface?: string
  offsetMeters?: number // lateral center offset from source reference line in meters
  lateralPlacement?: LateralPlacement
}

export interface RoadProfile {
  name?: string
  highwayClass?: string
  carriagewayWidthMeters: ProvenanceValue<number>
  roadwayWidthMeters?: ProvenanceValue<number>
  totalCorridorWidthMeters?: number | ProvenanceValue<number>
  totalCorridorWidth?: ProvenanceValue<number>
  lanes?: ProvenanceValue<number>
  forwardLanes?: ProvenanceValue<number>
  backwardLanes?: ProvenanceValue<number>
  speedLimit?: ProvenanceValue<number>
  direction?: 'forward' | 'backward' | 'both'
  oneWay?: boolean
  surface?: ProvenanceValue<string>
  sidewalks?: FacilityPresenceDetails
  cycleFacilities?: CycleFacilityPresenceDetails
  bridge?: boolean
  tunnel?: boolean
  layer?: number // vertical level [-5, +5]
  strips: CrossSectionStrip[]
  widthResolutionTier?: WidthResolutionTier
  drivingSide?: 'right' | 'left'
  profileFlags?: string[]
  laneAccuracyClaimed?: boolean
  laneAccuracyReason?: string
  facilityInferencePolicy?: FacilityInferencePolicy
  joinType?: GeometryJoinType
  miterLimit?: number
  capStart?: GeometryEndType
  capEnd?: GeometryEndType
  associatedSeparateFacilities?: AssociatedSeparateFacility[]
}

export interface BuildingProfile {
  levels?: ProvenanceValue<number>
  heightMeters?: ProvenanceValue<number>
  surface?: ProvenanceValue<string>
  footprintAreaSquareMeters?: ProvenanceValue<number>
  layer?: number
  isMeasured?: boolean
}

export type ViewMode = 'data' | 'realistic'

export interface OvertureConnectorRef {
  connectorId: string
  at: number // position along segment [0.0, 1.0]
}

export interface SourceReference {
  type: 'node' | 'way' | 'relation' | 'overture_segment' | 'overture_building' | 'custom'
  id: string | number
  nodes?: number[] // Ordered node IDs defining way geometry & connectivity
  members?: Array<{
    type: 'node' | 'way' | 'relation'
    ref: number
    role?: string
  }>
  tags?: Record<string, string>
  url?: string
  // Overture specific provenance and structure
  overtureId?: string
  sources?: Array<Record<string, unknown>>
  dataset?: string
  release?: string
  version?: number | string
  updateTime?: string
  connectors?: OvertureConnectorRef[]
  segmentRelative?: {
    between?: [number, number] // [start, end] fraction along parent geometry [0, 1]
    parentSourceId?: string
  }
}

export interface EditorFeature {
  id: string
  role: FeatureRole
  kind: SemanticKind // Explicit semantic kind (e.g. building, road, sidewalk, bike_facility, junction, unsupported)
  revision?: number // Effective revision counter incremented on feature/profile edits
  sourceId: string
  parentFeatureId?: string // Stable parent ID if feature is split from multipart/parent feature
  sourceReference?: SourceReference
  sourceGeometry: GeoJSON.Geometry // Immutable reference / source geometry
  effectiveGeometry?: GeoJSON.Geometry // Optional user-edited geometry if edited
  properties: Record<string, unknown>
  nodes?: number[] // Convenience ordered node connectivity IDs for network topology
  connectors?: OvertureConnectorRef[]
  overtureSources?: Array<Record<string, unknown>>
  sourceAttribution?: string
  sourceLicense?: string
  segmentRelative?: {
    between?: [number, number]
    parentSourceId?: string
  }
  roadProfile?: RoadProfile
  buildingProfile?: BuildingProfile
  inferred: {
    width: boolean
    sidewalk: boolean
    bikeLane: boolean
  }
  warnings?: string[]
  associatedRoadId?: string
  associatedFacilityIds?: string[]
  associatedSeparateFacilities?: AssociatedSeparateFacility[]
  boundaryRelation?: BoundarySpatialRelation
}
export interface FeatureEditOverride {
  featureId: string
  effectiveGeometry?: GeoJSON.Geometry
  roadProfile?: Partial<RoadProfile>
  buildingProfile?: Partial<BuildingProfile>
  properties?: Record<string, unknown>
  deleted?: boolean
  tags?: Record<string, string>
  [key: string]: unknown
}

export interface IncidentRoadBranch {
  featureId: string
  endpoint: 'start' | 'end' | 'interior'
  vertexIndex: number
  junctionCoord: { x: number; y: number }
  tangent: { x: number; y: number }
  angleRad: number
  layer: number
  carriagewayWidth: number
  isRoundabout: boolean
  isOneWay: boolean
  corridorWidth?: number
}

export interface JunctionNode {
  id: string
  sourceType: 'osm_node' | 'overture_connector' | 'shared_endpoint'
  sourceId: string | number
  point: { x: number; y: number }
  coordinates: { lon: number; lat: number }
  layer: number
  incidentRoads: IncidentRoadBranch[]
  isAtGrade: boolean
  isRoundabout: boolean
  unresolvedContinuity?: FacilityContinuityIssue[]
  isBoundaryJunction?: boolean
  boundaryRelation?: 'inside' | 'boundary' | 'outside'
  warnings?: string[]
}

export interface GeometricCrossing {
  featureIdA: string
  featureIdB: string
  intersectionPoint: { x: number; y: number }
  coordinates: { lon: number; lat: number }
  isTopologicallyConnected: boolean
  isGradeSeparated: boolean
  sourceTopologyPresent: boolean
  reason: 'shared_node' | 'shared_connector' | 'shared_endpoint' | 'grade_separated' | 'unconnected_geometric_crossing'
}
export type ContinuityFacilityType = 'sidewalk' | 'bike_lane' | 'cycleway'

export interface FacilityContinuityIssue {
  featureId: string
  junctionId: string
  facilityType: ContinuityFacilityType
  side?: 'left' | 'right' | 'both'
  reason: 'terminates_without_continuation' | 'missing_crossing' | 'dropped_at_intersection'
  message: string
}


export interface JunctionTopologyGraph {
  junctions: Map<string, JunctionNode>
  featureJunctions: Map<string, string[]>
  crossings: GeometricCrossing[]
  getJunction(junctionId: string): JunctionNode | undefined
  getJunctionsForFeature(featureId: string): JunctionNode[]
  getIncidentBranches(junctionId: string): IncidentRoadBranch[]
  areFeaturesConnected(featureIdA: string, featureIdB: string): boolean
  isGeometricCrossingWithoutTopology(featureIdA: string, featureIdB: string): boolean
  getAtGradeJunctions(): JunctionNode[]
  getBoundaryJunctions(): JunctionNode[]
  getGradeSeparatedCrossings(): GeometricCrossing[]
  getUnconnectedCrossings(): GeometricCrossing[]
  getUnresolvedContinuityIssues(): FacilityContinuityIssue[]
  getUnresolvedContinuityForFeature(featureId: string): FacilityContinuityIssue[]
  getUnresolvedContinuityForJunction(junctionId: string): FacilityContinuityIssue[]
  updateFeatureRoadProfile?(feature: EditorFeature): string[]
  recomputeJunctionGeometry?(junctionId: string): boolean
}

export interface RecomputationStats {
  affectedFeatureIds: string[]
  affectedJunctionIds: string[]
  totalFeaturesRecomputed: number
  totalJunctionsRecomputed: number
  reusedFeaturesCount?: number
  recomputeType: 'full' | 'incremental_road' | 'incremental_building' | 'incremental_display'
  timestamp: number
}

export interface EditorSettings {
  viewMode?: ViewMode
  units?: 'metric' | 'imperial'
  showInferredBadges?: boolean
  defaultRoadWidthMeters?: number
  layerVisibility?: Record<string, boolean>
  exportInclusions?: Record<string, boolean>
  coordinateOrderConvention?: 'left_right_relative_to_source_coordinates'
  facilityInferencePolicy?: FacilityInferencePolicy
  clippingPolicy?: ExportClippingPolicy
}

export type ExportClippingMode =
  | 'clip_to_bounds'
  | 'buffer_bounds'
  | 'preserve_cross_boundary'
  | 'unclipped'

export type BuildingClippingMode =
  | 'clip_footprint'
  | 'keep_intersecting'
  | 'centroid_inside'

export interface ExportClippingPolicy {
  mode: ExportClippingMode
  bufferMarginMeters?: number
  buildingMode?: BuildingClippingMode
  filterOutsideFeatures?: boolean
}

export type BoundarySpatialRelation = 'inside' | 'cross_boundary' | 'outside'

export interface ExportClippingStats {
  totalSurfaces: number
  retainedSurfaces: number
  clippedSurfaces: number
  omittedSurfaces: number
  totalFeatures: number
  retainedFeatures: number
  crossBoundaryFeatures: number
  outsideFeaturesOmitted: number
  policyApplied: ExportClippingPolicy
}

export type LayerCategory =
  | 'road'
  | 'carriageway'
  | 'building'
  | 'sidewalk'
  | 'footway'
  | 'cycling'
  | 'bike_lane'
  | 'bike_facility'
  | 'cycleway'
  | 'junction'
  | 'junction_surfaces'
  | 'unsupported'
  | 'centerlines'
  | 'vertices'
  | 'labels'
  | 'warning_overlays'
  | 'inference_overlays'

export interface ExportExclusionItem {
  category: string
  label: string
  count: number
}

export interface ExportSummary {
  hasExclusions: boolean
  excludedCategories: string[]
  excludedFeatureCount: number
  includedFeatureCount: number
  totalFeatureCount: number
  summaryText: string
  exclusions: ExportExclusionItem[]
}
export const DEFAULT_LAYER_VISIBILITY: Record<string, boolean> = {
  road: true,
  carriageway: true,
  building: true,
  sidewalk: true,
  footway: true,
  cycling: true,
  bike_lane: true,
  bike_facility: true,
  cycleway: true,
  junction: true,
  junction_surfaces: true,
  unsupported: true,
  centerlines: true,
  vertices: true,
  labels: true,
  warning_overlays: true,
  inference_overlays: true
}

export const DEFAULT_EXPORT_INCLUSIONS: Record<string, boolean> = {
  road: true,
  carriageway: true,
  building: true,
  sidewalk: true,
  footway: true,
  cycling: true,
  bike_lane: true,
  bike_facility: true,
  cycleway: true,
  junction: true,
  unsupported: true
}

export function mapKindToCategory(kind?: string, role?: string): string {
  if (kind === 'centerlines' || role === 'centerlines') return 'centerlines'
  if (kind === 'vertex' || kind === 'vertices' || role === 'vertex' || role === 'vertices') return 'vertices'
  if (kind === 'label' || kind === 'labels' || role === 'label' || role === 'labels') return 'labels'
  if (kind === 'warning_overlay' || kind === 'warning_overlays' || role === 'warning_overlay' || role === 'warning_overlays') return 'warning_overlays'
  if (kind === 'inference_overlay' || kind === 'inference_overlays' || role === 'inference_overlay' || role === 'inference_overlays') return 'inference_overlays'
  if (kind === 'sidewalk' || role === 'sidewalk' || kind === 'footway' || role === 'footway') return 'sidewalk'
  if (kind === 'cycleway' || role === 'cycleway' || kind === 'bike_facility' || role === 'bike_facility') {
    return 'cycleway'
  }
  if (kind === 'bike_lane' || role === 'bike_lane') {
    return 'bike_lane'
  }
  if (kind === 'cycling' || role === 'cycling') {
    return 'cycling'
  }
  if (kind === 'building' || role === 'building') return 'building'
  if (kind === 'junction' || role === 'junction' || kind === 'junction_surfaces' || role === 'junction_surfaces') return 'junction'
  if (kind === 'road' || kind === 'carriageway' || kind === 'centerline' || role === 'road' || role === 'carriageway') return 'carriageway'
  return 'unsupported'
}

export interface SourceAttributionItem {
  dataset?: string
  attribution?: string
  license?: string
  url?: string
  recordId?: string
}

export interface SourceMetadata {
  source: 'osm' | 'overture' | 'custom'
  acquisitionSource?: string
  areaName?: string
  bbox?: [number, number, number, number] // [minLon, minLat, maxLon, maxLat]
  attribution?: string
  attributions?: string[]
  license?: string
  licenses?: string[]
  sourceAttributions?: SourceAttributionItem[]
  sources?: Array<Record<string, unknown>>
  release?: string
  overtureRelease?: string
  dataset?: string
  nodes?: Record<string, number | { lat: number; lon: number; tags?: Record<string, string> }>
  nodeConnectivity?: Record<string | number, string[]> // node ID -> array of feature IDs sharing this node
  connectorConnectivity?: Record<string, string[]> // connectorId -> feature IDs sharing this connector
  [key: string]: unknown
}

export const CURRENT_PROJECT_SCHEMA_VERSION = '1.0.0'
export const SUPPORTED_PROJECT_SCHEMA_VERSIONS = ['1.0.0'] as const
export type SupportedProjectSchemaVersion = (typeof SUPPORTED_PROJECT_SCHEMA_VERSIONS)[number]

export function isSupportedSchemaVersion(version: unknown): version is SupportedProjectSchemaVersion {
  return typeof version === 'string' && SUPPORTED_PROJECT_SCHEMA_VERSIONS.includes(version as SupportedProjectSchemaVersion)
}

export const CURRENT_EDITOR_PAYLOAD_VERSION = '1.0.0'
export const SUPPORTED_EDITOR_PAYLOAD_VERSIONS = ['1.0.0'] as const
export type SupportedEditorPayloadVersion = (typeof SUPPORTED_EDITOR_PAYLOAD_VERSIONS)[number]

export function isSupportedEditorPayloadVersion(version: unknown): version is SupportedEditorPayloadVersion {
  return typeof version === 'string' && SUPPORTED_EDITOR_PAYLOAD_VERSIONS.includes(version as SupportedEditorPayloadVersion)
}

export interface EditorExportMetadata {
  generator: 'osm-to-godot-editor'
  version: '1.0.0' | string
  exportedAt: string
  sourceMetadata: SourceMetadata
  attribution?: string
  attributions?: string[]
  license?: string
  licenses?: string[]
  sourceAttributions?: SourceAttributionItem[]
  projectionOrigin: { lon: number; lat: number }
  projection?: {
    type: 'equirectangular_local_tangent'
    earthRadius: number
    origin: { lon: number; lat: number }
    axes: {
      x: string
      y: string
      z: string
    }
    unit: 'meter'
  }
  selectedBounds?: [number, number, number, number]
  exportInclusions: Record<string, boolean>
  featureCounts: {
    total: number
    roads: number
    buildings: number
    sidewalks: number
    bikeLanes: number
    junctions: number
    unsupported?: number
  }
  exclusions?: string[]
  assumptions?: string[]
  warnings?: string[]
  clippingPolicy?: ExportClippingPolicy
  blockingErrors?: BlockingGeometryError[]
  [key: string]: unknown
}

export interface BlockingGeometryError {
  featureId: string
  role?: FeatureRole | string
  kind?: string
  message: string
  geometryType?: string
}

export interface SceneExportPreflightCounts {
  totalFeatures: number
  includedFeatures: number
  excludedFeatures: number
  totalSurfaces: number
  roads: number
  buildings: number
  sidewalks: number
  bikeLanes: number
  junctions: number
  unsupported: number
}

export interface SceneExportPreflightExclusions {
  hasExclusions: boolean
  categories: string[]
  items: ExportExclusionItem[]
  totalExcluded: number
}

export interface SceneExportPreflightAttribution {
  source: 'osm' | 'overture' | 'custom'
  attribution: string
  attributions: string[]
  license: string
  licenses: string[]
  sourceAttributions: SourceAttributionItem[]
}

export interface SceneExportPreflight {
  canGenerate: boolean
  counts: SceneExportPreflightCounts
  exclusions: SceneExportPreflightExclusions
  assumptions: string[]
  blockingErrors: BlockingGeometryError[]
  warnings: string[]
  attribution?: SceneExportPreflightAttribution
}

export interface EditorExportFeature extends GeoJSON.Feature {
  id: string
  properties: {
    id: string
    role: FeatureRole
    kind: string
    parentFeatureId?: string
    stripId?: string
    side?: 'left' | 'right' | 'center'
    direction?: 'forward' | 'backward' | 'both'
    widthMeters?: number
    heightMeters?: number
    levels?: number
    isPolygon: boolean
    isFootprintAuthority: boolean
    lateralPlacement?: LateralPlacement
    roadProfile?: RoadProfile
    buildingProfile?: BuildingProfile
    centerline?: GeoJSON.LineString
    isSemanticCenterline?: boolean
    provenance?: Provenance
    isInferredWidth?: boolean
    isInferredFacility?: boolean
    isClipped?: boolean
    boundaryRelation?: string
    sourceTags?: Record<string, string>
    sourceProperties?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface EditorGodotPayload {
  type: 'FeatureCollection'
  generator: 'osm-to-godot-editor'
  editorPayloadVersion: '1.0.0' | string
  metadata: EditorExportMetadata
  attribution?: string
  license?: string
  projectionOrigin: { lon: number; lat: number }
  projection?: {
    type: 'equirectangular_local_tangent'
    earthRadius: number
    origin: { lon: number; lat: number }
    axes: {
      x: '+East (meters)'
      y: '+North (meters 2D tangent plane, +Up in Godot 3D)'
      z: '-North (meters in Godot 3D)'
    }
    unit: 'meter'
  }
  clippingPolicy?: ExportClippingPolicy
  clippingStats?: ExportClippingStats
  features: EditorExportFeature[]
}

export interface ProjectEnvelope {
  schemaVersion: '1.0.0' | string
  sourceMetadata: SourceMetadata
  selectedBounds?: [number, number, number, number] // [minLon, minLat, maxLon, maxLat]
  projectionOrigin: {
    lon: number
    lat: number
  }
  projection?: {
    type: 'equirectangular_local_tangent'
    earthRadius: number
    origin: { lon: number; lat: number }
    axes: {
      x: '+East (meters)'
      y: '+North (meters 2D tangent plane, +Up in Godot 3D)'
      z: '-North (meters in Godot 3D)'
    }
    unit: 'meter'
  }
  sourceFeatures?: EditorFeature[] // Immutable source features as acquired/normalized
  features: EditorFeature[] // Active editable features
  editOverrides?: Record<string, FeatureEditOverride>
  editorSettings?: EditorSettings
  warnings?: string[]
  clipping?: {
    policy: ExportClippingPolicy
    stats?: ExportClippingStats
    selectedBounds?: [number, number, number, number]
  }
}

export interface ViewSurface {
  id: string
  parentFeatureId: string
  stripId?: string // References CrossSectionStrip.id within parent roadProfile
  role: FeatureRole
  kind?: string
  viewMode: ViewMode
  geometry: GeoJSON.Geometry // LineString in data view for roads, Polygon in realistic view
  drawOrder?: number
  properties: {
    widthMeters?: number
    isPolygon: boolean
    isInferredWidth?: boolean
    isInferredFacility?: boolean
    surface?: string
    stripId?: string
    isGeometryFallback?: boolean
    isGeometryInvalid?: boolean
    geometryDerivationStatus?: 'valid' | 'fallback' | 'warning' | 'failed'
    warnings?: string[]
    [key: string]: unknown
  }
}

export interface CategoryAvailability {
  category: string
  label: string
  count: number
  available: boolean
  explanation: string
}
