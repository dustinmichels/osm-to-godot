import type {
  EditorFeature,
  ViewMode,
  ViewSurface,
  FeatureRole,
  JunctionTopologyGraph
} from './types'
import type { Point2D } from './projection'
import { offsetPolylineToPolygon, RibbonOffsetOptions, generateMetricRibbonPolygon } from './ribbon'
import { projectToLocalMeters } from './projection'
import { buildJunctionTopology } from './junctionTopology'
import {
  generateJunctionSurfaces,
  trimRoadSurfacePolygons,
  ringsToGeoJsonGeometry
} from './junctionGeometry'
import { addFeatureWarning, addFeatureProfileFlag } from './geometryWarnings'

export const CATEGORY_DRAW_RANKS: Record<string, number> = {
  junction: 10,
  junction_surfaces: 10,

  // Base vehicular roadways
  carriageway: 20,
  road: 20,
  centerline: 20,

  parking: 22,
  median: 23,
  buffer: 24,
  // Facilities (painted or offset alongside/atop base carriageway)
  bike_lane: 30,
  cycleway: 30,
  bike_facility: 30,
  sidewalk: 30,
  footway: 30,

  // Buildings (above ground pavement, but underneath bridges crossing over)
  building: 40,

  // Subordinate presentation overlays (sit atop physical geometries)
  centerlines: 50,
  vertices: 60,
  labels: 70,
  inference_overlays: 80,
  warning_overlays: 80,

  // Fallback
  unsupported: 25
}

export function getFeatureEffectiveLayer(feature?: {
  roadProfile?: { layer?: number; bridge?: boolean; tunnel?: boolean }
  buildingProfile?: { layer?: number }
  properties?: Record<string, unknown>
  role?: string
  kind?: string
}): number {
  if (!feature) return 0
  if (feature.roadProfile?.layer !== undefined && Number.isFinite(feature.roadProfile.layer)) {
    return feature.roadProfile.layer
  }
  if (feature.buildingProfile?.layer !== undefined && Number.isFinite(feature.buildingProfile.layer)) {
    return feature.buildingProfile.layer
  }
  if (typeof feature.properties?.layer === 'number' && Number.isFinite(feature.properties.layer)) {
    return feature.properties.layer
  }
  if (typeof feature.properties?.layer === 'string') {
    const parsed = parseInt(feature.properties.layer, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  if (
    feature.roadProfile?.bridge ||
    feature.properties?.bridge === 'yes' ||
    feature.properties?.bridge === true ||
    feature.properties?.bridge === 'true'
  ) {
    return 1
  }
  if (
    feature.roadProfile?.tunnel ||
    feature.properties?.tunnel === 'yes' ||
    feature.properties?.tunnel === true ||
    feature.properties?.tunnel === 'true'
  ) {
    return -1
  }
  return 0
}

export function computeDrawOrder(params: {
  layer?: number
  bridge?: boolean
  tunnel?: boolean
  category?: string
  kind?: string
  role?: string
}): number {
  let effectiveLayer = 0
  if (params.layer !== undefined && Number.isFinite(params.layer)) {
    effectiveLayer = params.layer
  } else if (params.bridge) {
    effectiveLayer = 1
  } else if (params.tunnel) {
    effectiveLayer = -1
  }

  const cat = params.category || params.kind || params.role || 'unsupported'
  const rank = CATEGORY_DRAW_RANKS[cat] ?? 25

  return effectiveLayer * 1000 + rank
}

export function areFeaturesGradeSeparated(
  featureA?: Parameters<typeof getFeatureEffectiveLayer>[0],
  featureB?: Parameters<typeof getFeatureEffectiveLayer>[0]
): boolean {
  return getFeatureEffectiveLayer(featureA) !== getFeatureEffectiveLayer(featureB)
}

function ccw(p1: [number, number], p2: [number, number], p3: [number, number]): number {
  return (p3[1] - p1[1]) * (p2[0] - p1[0]) - (p2[1] - p1[1]) * (p3[0] - p1[0])
}

function onSegment(p: [number, number], a: [number, number], b: [number, number]): boolean {
  return (
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9
  )
}

function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  q1: [number, number],
  q2: [number, number]
): boolean {
  const o1 = ccw(p1, q1, q2)
  const o2 = ccw(p2, q1, q2)
  const o3 = ccw(q1, p1, p2)
  const o4 = ccw(q2, p1, p2)

  if (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  ) {
    return true
  }

  if (Math.abs(o1) < 1e-12 && onSegment(p1, q1, q2)) return true
  if (Math.abs(o2) < 1e-12 && onSegment(p2, q1, q2)) return true
  if (Math.abs(o3) < 1e-12 && onSegment(q1, p1, p2)) return true
  if (Math.abs(o4) < 1e-12 && onSegment(q2, p1, p2)) return true

  return false
}

export function doLineStringsIntersect2D(
  coordsA: number[][],
  coordsB: number[][]
): boolean {
  if (!coordsA || !coordsB || coordsA.length < 2 || coordsB.length < 2) return false

  let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity
  for (const p of coordsA) {
    if (p[0] < minAx) minAx = p[0]
    if (p[0] > maxAx) maxAx = p[0]
    if (p[1] < minAy) minAy = p[1]
    if (p[1] > maxAy) maxAy = p[1]
  }

  let minBx = Infinity, maxBx = -Infinity, minBy = Infinity, maxBy = -Infinity
  for (const p of coordsB) {
    if (p[0] < minBx) minBx = p[0]
    if (p[0] > maxBx) maxBx = p[0]
    if (p[1] < minBy) minBy = p[1]
    if (p[1] > maxBy) maxBy = p[1]
  }

  if (maxAx < minBx || minAx > maxBx || maxAy < minBy || minAy > maxBy) {
    return false
  }

  for (let i = 0; i < coordsA.length - 1; i++) {
    const a1 = coordsA[i] as [number, number]
    const a2 = coordsA[i + 1] as [number, number]
    for (let j = 0; j < coordsB.length - 1; j++) {
      const b1 = coordsB[j] as [number, number]
      const b2 = coordsB[j + 1] as [number, number]
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true
      }
    }
  }

  return false
}

export function doFeaturesIntersect2D(
  featureA: EditorFeature,
  featureB: EditorFeature
): boolean {
  const geomA = featureA.effectiveGeometry || featureA.sourceGeometry
  const geomB = featureB.effectiveGeometry || featureB.sourceGeometry
  if (geomA?.type === 'LineString' && geomB?.type === 'LineString') {
    return doLineStringsIntersect2D(geomA.coordinates, geomB.coordinates)
  }
  return false
}

export function canJoinAtCrossing(
  featureA?: Parameters<typeof getFeatureEffectiveLayer>[0],
  featureB?: Parameters<typeof getFeatureEffectiveLayer>[0]
): boolean {
  if (areFeaturesGradeSeparated(featureA, featureB)) {
    return false
  }
  return true
}

function stripKindToFeatureRole(kind: string): FeatureRole {
  if (kind === 'carriageway') return 'road'
  if (kind === 'sidewalk') return 'sidewalk'
  if (kind === 'bike_lane') return 'bike_lane'
  if (kind === 'cycleway') return 'bike_facility'
  return 'road'
}

/**
 * Derives presentation surfaces for a given view mode without mutating source features.
 * In 'data' view:
 *   - Roads are returned as their source/reference LineStrings.
 *   - Buildings and source polygons are returned as their source Polygon outlines/geometries.
 * In 'realistic' view:
 *   - Roads are computed as width-aware carriageway/strip Polygons via metric offsets.
 *   - Buildings remain Polygons (never converted to centerlines).
 *   - Attached facilities (sidewalks, bike lanes) are emitted as independent strip Polygons.
 *   - Inferred widths and facilities are surfaced in properties.
 */
export interface FeatureSurfaceContext {
  junctionPolygonMap?: Map<string, Point2D[][]>
  junctionTrimmingMap?: Map<string, Point2D[][]>
  junctionGraph?: JunctionTopologyGraph
  emittedJunctionIds?: Set<string>
}

export function generateSurfacesForFeature(
  feature: EditorFeature,
  viewMode: ViewMode,
  origin: { lon: number; lat: number },
  context?: FeatureSurfaceContext
): ViewSurface[] {
  const surfaces: ViewSurface[] = []
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom) {
    addFeatureWarning(feature, `Feature ${feature.id} has no geometry. Inspectable source data preserved.`)
    return surfaces
  }

  const effectiveJunctionGraph = context?.junctionGraph
  const junctionPolygonMap = context?.junctionPolygonMap ?? new Map<string, Point2D[][]>()
  const junctionTrimmingMap = context?.junctionTrimmingMap ?? new Map<string, Point2D[][]>()
  const emittedJunctionIds = context?.emittedJunctionIds ?? new Set<string>()

    const effectiveLayer = getFeatureEffectiveLayer(feature)
    const bridge = Boolean(
      feature.roadProfile?.bridge ||
        feature.properties?.bridge === 'yes' ||
        feature.properties?.bridge === true ||
        feature.properties?.bridge === 'true'
    )
    const tunnel = Boolean(
      feature.roadProfile?.tunnel ||
        feature.properties?.tunnel === 'yes' ||
        feature.properties?.tunnel === true ||
        feature.properties?.tunnel === 'true'
    )

    if (feature.role === 'building' || feature.kind === 'building') {
      let isGeomValid = true
      if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
        isGeomValid = false
        addFeatureWarning(
          feature,
          `Building feature ${feature.id} has geometry type '${geom.type}'; expected Polygon or MultiPolygon. Inspectable source data preserved.`
        )
      } else if (geom.type === 'Polygon') {
        const rings = geom.coordinates
        if (!Array.isArray(rings) || rings.length === 0 || !Array.isArray(rings[0]) || rings[0].length < 4) {
          isGeomValid = false
          addFeatureWarning(
            feature,
            `Building outer ring has fewer than 4 coordinates. Inspectable source data preserved.`
          )
        } else {
          for (let rIdx = 0; rIdx < rings.length; rIdx++) {
            const ring = rings[rIdx]
            if (!Array.isArray(ring) || ring.length < 4) {
              isGeomValid = false
              addFeatureWarning(
                feature,
                rIdx === 0
                  ? `Building outer ring has fewer than 4 coordinates. Inspectable source data preserved.`
                  : `Building inner ring (hole) has fewer than 4 coordinates. Inspectable source data preserved.`
              )
            } else {
              const first = ring[0]
              const last = ring[ring.length - 1]
              if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
                isGeomValid = false
                addFeatureWarning(
                  feature,
                  rIdx === 0
                    ? 'Building polygon ring is not closed. Inspectable source data preserved.'
                    : 'Building inner ring (hole) is not closed. Inspectable source data preserved.'
                )
              }
            }
          }
        }
      } else if (geom.type === 'MultiPolygon') {
        const polys = geom.coordinates
        if (!Array.isArray(polys) || polys.length === 0) {
          isGeomValid = false
          addFeatureWarning(
            feature,
            `Building MultiPolygon has no parts. Inspectable source data preserved.`
          )
        } else {
          for (const poly of polys) {
            if (!Array.isArray(poly) || poly.length === 0) {
              isGeomValid = false
              addFeatureWarning(
                feature,
                `Building MultiPolygon part has no outer ring. Inspectable source data preserved.`
              )
            } else {
              for (let rIdx = 0; rIdx < poly.length; rIdx++) {
                const ring = poly[rIdx]
                if (!Array.isArray(ring) || ring.length < 4) {
                  isGeomValid = false
                  addFeatureWarning(
                    feature,
                    rIdx === 0
                      ? `Building outer ring has fewer than 4 coordinates. Inspectable source data preserved.`
                      : `Building inner ring (hole) has fewer than 4 coordinates. Inspectable source data preserved.`
                  )
                } else {
                  const first = ring[0]
                  const last = ring[ring.length - 1]
                  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
                    isGeomValid = false
                    addFeatureWarning(
                      feature,
                      rIdx === 0
                        ? 'Building polygon ring is not closed. Inspectable source data preserved.'
                        : 'Building inner ring (hole) is not closed. Inspectable source data preserved.'
                    )
                  }
                }
              }
            }
          }
        }
      }

      // Invariant: Keep source polygons as polygons; do not derive centerlines.
      const drawOrder = computeDrawOrder({
        layer: effectiveLayer,
        category: 'building',
        kind: 'building',
        role: 'building'
      })
      surfaces.push({
        id: `${feature.id}_surface`,
        parentFeatureId: feature.id,
        role: 'building',
        kind: 'building',
        viewMode,
        geometry: geom,
        drawOrder,
        properties: {
          layer: effectiveLayer,
          drawOrder,
          isPolygon: geom.type === 'Polygon' || geom.type === 'MultiPolygon',
          surface: feature.buildingProfile?.surface?.value ?? 'building',
          levels: feature.buildingProfile?.levels?.value,
          heightMeters: feature.buildingProfile?.heightMeters?.value,
          isInferredLevels: feature.buildingProfile?.levels?.provenance === 'inferred',
          isGeometryFallback: !isGeomValid,
          isGeometryInvalid: !isGeomValid,
          geometryDerivationStatus: isGeomValid ? 'valid' : 'warning',
          warnings: feature.warnings
        }
      })
      return surfaces
    }

    const isLinearWay =
      (feature.role === 'road' ||
        feature.kind === 'road' ||
        feature.role === 'sidewalk' ||
        feature.kind === 'sidewalk' ||
        feature.role === 'bike_facility' ||
        feature.kind === 'bike_facility' ||
        feature.role === 'bike_lane') &&
      geom.type === 'LineString'

    if (isLinearWay) {
      const isCyclewayFeature =
        feature.role === 'bike_facility' ||
        feature.kind === 'bike_facility' ||
        feature.properties?.highway === 'cycleway' ||
        feature.properties?.subtype === 'cycleway'
      const isFootwayFeature =
        feature.role === 'sidewalk' ||
        feature.kind === 'sidewalk' ||
        feature.properties?.highway === 'footway' ||
        feature.properties?.highway === 'pedestrian' ||
        feature.properties?.highway === 'path' ||
        feature.properties?.subtype === 'sidewalk'

      if (viewMode === 'data') {
        // Data view: Source/reference line, direction, optional vertices
        const surfaceKind = isCyclewayFeature ? 'cycleway' : isFootwayFeature ? 'sidewalk' : 'centerline'
        const surfaceRole = isCyclewayFeature ? 'bike_facility' : isFootwayFeature ? 'sidewalk' : 'road'
        const coords = (geom as GeoJSON.LineString).coordinates
        const isDegenerate = !coords || coords.length < 2
        const hasInvalidCoord = coords?.some(
          (c) => !Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])
        )
        if (isDegenerate) {
          addFeatureWarning(
            feature,
            `Feature ${feature.id} has fewer than 2 coordinates. Preserving source geometry.`
          )
        } else if (hasInvalidCoord) {
          addFeatureWarning(
            feature,
            `Feature ${feature.id} contains non-finite or invalid coordinates. Preserving source geometry.`
          )
        }
        const drawOrder = computeDrawOrder({
          layer: effectiveLayer,
          bridge,
          tunnel,
          category: surfaceKind,
          kind: surfaceKind,
          role: surfaceRole
        })
        surfaces.push({
          id: `${feature.id}_line`,
          parentFeatureId: feature.id,
          role: surfaceRole,
          kind: surfaceKind,
          viewMode: 'data',
          geometry: geom,
          drawOrder,
          properties: {
            layer: effectiveLayer,
            bridge,
            tunnel,
            drawOrder,
            widthMeters: feature.roadProfile?.carriagewayWidthMeters.value,
            totalCorridorWidthMeters: feature.roadProfile?.totalCorridorWidthMeters,
            direction: feature.roadProfile?.direction ?? 'both',
            oneWay: feature.roadProfile?.oneWay ?? false,
            isPolygon: false,
            isInferredWidth: feature.inferred?.width ?? false,
            isInferredFacility: false,
            highwayClass: feature.roadProfile?.highwayClass,
            isStandaloneCycleway: isCyclewayFeature,
            isGeometryFallback: isDegenerate,
            geometryDerivationStatus: isDegenerate ? 'warning' : 'valid',
            warnings: feature.warnings,
            coordinateOrderConvention: 'left_right_relative_to_source_coordinates'
          }
        })
      } else {
        // Realistic view: Metric width-aware carriageway polygon + offset strips
        const initialSurfacesCount = surfaces.length
        try {
          const profile = feature.roadProfile
          const coords = (geom as GeoJSON.LineString).coordinates

          if (!profile) {
            addFeatureWarning(
              feature,
              `Road feature ${feature.id} has no profile. Displaying source geometry fallback.`
            )
            addFeatureProfileFlag(feature, 'geometry_fallback')
          } else if (!coords || coords.length < 2) {
            addFeatureWarning(
              feature,
              `Road feature ${feature.id} has fewer than 2 coordinates. Preserving source geometry.`
            )
            addFeatureProfileFlag(feature, 'invalid_derived_geometry')
            addFeatureProfileFlag(feature, 'geometry_fallback')
          } else {
            const hasInvalidCoord = coords.some(
              (c) => !Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])
            )
            if (hasInvalidCoord) {
              addFeatureWarning(
                feature,
                `Feature ${feature.id} contains non-finite or invalid coordinates. Preserving source geometry.`
              )
              addFeatureProfileFlag(feature, 'invalid_derived_geometry')
            }
            const isClosed =
              coords.length >= 3 &&
              coords[0][0] === coords[coords.length - 1][0] &&
              coords[0][1] === coords[coords.length - 1][1]

            const ribbonOptions: RibbonOffsetOptions = {
              joinType: profile.joinType ?? 'miter',
              miterLimit: profile.miterLimit ?? 2.5,
              capStart: profile.capStart ?? 'butt',
              capEnd: profile.capEnd ?? 'butt',
              isClosedLoop: isClosed
            }

            const localPoints = coords.map(([lon, lat]) =>
              projectToLocalMeters(lon, lat, origin.lon, origin.lat)
            )

            const incidentJuncs = effectiveJunctionGraph
              ? effectiveJunctionGraph
                  .getJunctionsForFeature(feature.id)
                  .filter((j) => j.isAtGrade && j.layer === effectiveLayer)
              : []
            const incidentJuncRings = incidentJuncs.flatMap(
              (j) => junctionTrimmingMap.get(j.id) ?? junctionPolygonMap.get(j.id) ?? []
            )

            // If custom strips are defined, generate each strip
            if (profile.strips && profile.strips.length > 0) {
              let currentOffset = 0
              let validStripsAttempted = 0
              for (const strip of profile.strips) {
                if (!strip || !Number.isFinite(strip.widthMeters) || strip.widthMeters <= 0) {
                  addFeatureWarning(
                    feature,
                    `Strip '${strip?.id || 'unknown'}' has invalid width (${strip?.widthMeters}m). Strips must have positive finite width.`
                  )
                  continue
                }
                validStripsAttempted++
                const halfWidth = strip.widthMeters / 2.0
                // Position strip laterally relative to reference line
                const leftOffset = -(strip.offsetMeters ?? currentOffset) + halfWidth
                const rightOffset = (strip.offsetMeters ?? currentOffset) + halfWidth

                const metricRings = generateMetricRibbonPolygon(
                  localPoints,
                  leftOffset,
                  rightOffset,
                  ribbonOptions
                )
                if (metricRings.length === 0) {
                  addFeatureWarning(
                    feature,
                    `Derived strip '${strip.id}' polygon collapsed or could not be generated.`
                  )
                  continue
                }

                const trimmedMetricRings =
                  incidentJuncRings.length > 0
                    ? trimRoadSurfacePolygons(metricRings, incidentJuncRings)
                    : metricRings

                if (trimmedMetricRings.length === 0) {
                  addFeatureWarning(
                    feature,
                    `Derived strip '${strip.id}' was fully trimmed away by incident junctions.`
                  )
                  continue
                }

                const isStripCycleway =
                  strip.kind === 'cycleway' ||
                  (isCyclewayFeature && strip.kind === 'carriageway')
                const isStripFootway =
                  strip.kind === 'sidewalk' ||
                  (isFootwayFeature && strip.kind === 'carriageway')
                const effectiveKind = isStripCycleway ? 'cycleway' : isStripFootway ? 'sidewalk' : strip.kind
                const effectiveRole = isStripCycleway
                  ? 'bike_facility'
                  : (isStripFootway || strip.kind === 'sidewalk')
                    ? 'sidewalk'
                    : stripKindToFeatureRole(strip.kind)
                const drawOrder = computeDrawOrder({
                  layer: effectiveLayer,
                  bridge,
                  tunnel,
                  category: effectiveKind,
                  kind: effectiveKind,
                  role: effectiveRole
                })
                const geomObj = ringsToGeoJsonGeometry(trimmedMetricRings, origin)

                surfaces.push({
                  id: `${feature.id}_strip_${strip.id}`,
                  parentFeatureId: feature.id,
                  stripId: strip.id,
                  role: effectiveRole,
                  kind: effectiveKind,
                  viewMode: 'realistic',
                  geometry: geomObj,
                  drawOrder,
                  properties: {
                    layer: effectiveLayer,
                    bridge,
                    tunnel,
                    drawOrder,
                    widthMeters: strip.widthMeters,
                    isPolygon: true,
                    isInferredWidth: strip.provenance === 'inferred',
                    isInferredFacility: Boolean(feature.inferred?.sidewalk || feature.inferred?.bikeLane),
                    surface: strip.surface ?? profile.surface?.value ?? 'asphalt',
                    stripId: strip.id,
                    side: strip.side,
                    direction: strip.direction,
                    lateralPlacement: strip.lateralPlacement,
                    isStandaloneCycleway: isStripCycleway,
                    isOnRoadBikeLane: strip.kind === 'bike_lane',
                    joinType: ribbonOptions.joinType,
                    miterLimit: ribbonOptions.miterLimit,
                    capStart: ribbonOptions.capStart,
                    capEnd: ribbonOptions.capEnd,
                    isClosedLoop: isClosed,
                    coordinateOrderConvention: 'left_right_relative_to_source_coordinates'
                  }
                })
              }
              if (validStripsAttempted > 0 && surfaces.length === initialSurfacesCount) {
                addFeatureWarning(
                  feature,
                  'All derived facility strips collapsed or were completely trimmed away. Displaying source geometry fallback.'
                )
                addFeatureProfileFlag(feature, 'invalid_derived_geometry')
                addFeatureProfileFlag(feature, 'geometry_fallback')
              }
            } else {
              // Default symmetric carriageway offset around reference line
              const widthVal = profile.carriagewayWidthMeters?.value
              if (!Number.isFinite(widthVal) || widthVal <= 0) {
                addFeatureWarning(
                  feature,
                  `Carriageway has invalid or non-positive width (${widthVal}m). Displaying source geometry fallback.`
                )
                addFeatureProfileFlag(feature, 'invalid_derived_geometry')
                addFeatureProfileFlag(feature, 'geometry_fallback')
              } else {
                const halfWidth = widthVal / 2.0
                const metricRings = generateMetricRibbonPolygon(
                  localPoints,
                  halfWidth,
                  halfWidth,
                  ribbonOptions
                )
                if (metricRings.length === 0) {
                  addFeatureWarning(
                    feature,
                    'Carriageway ribbon polygon collapsed or could not be generated. Displaying source geometry fallback.'
                  )
                  addFeatureProfileFlag(feature, 'invalid_derived_geometry')
                  addFeatureProfileFlag(feature, 'geometry_fallback')
                } else {
                  const trimmedMetricRings =
                    incidentJuncRings.length > 0
                      ? trimRoadSurfacePolygons(metricRings, incidentJuncRings)
                      : metricRings

                  if (trimmedMetricRings.length === 0) {
                    addFeatureWarning(
                      feature,
                      'Carriageway polygon was fully clipped by incident junctions. Displaying source geometry fallback.'
                    )
                    addFeatureProfileFlag(feature, 'geometry_clipped_by_junctions')
                    addFeatureProfileFlag(feature, 'geometry_fallback')
                  } else {
                    const surfaceKind = isCyclewayFeature ? 'cycleway' : isFootwayFeature ? 'sidewalk' : 'carriageway'
                    const surfaceRole = isCyclewayFeature ? 'bike_facility' : isFootwayFeature ? 'sidewalk' : 'road'
                    const drawOrder = computeDrawOrder({
                      layer: effectiveLayer,
                      bridge,
                      tunnel,
                      category: surfaceKind,
                      kind: surfaceKind,
                      role: surfaceRole
                    })
                    const geomObj = ringsToGeoJsonGeometry(trimmedMetricRings, origin)

                    surfaces.push({
                      id: `${feature.id}_carriageway`,
                      parentFeatureId: feature.id,
                      role: surfaceRole,
                      kind: surfaceKind,
                      viewMode: 'realistic',
                      geometry: geomObj,
                      drawOrder,
                      properties: {
                        layer: effectiveLayer,
                        bridge,
                        tunnel,
                        drawOrder,
                        widthMeters: profile.carriagewayWidthMeters.value,
                        totalCorridorWidthMeters: profile.totalCorridorWidthMeters,
                        isPolygon: true,
                        isInferredWidth: Boolean(feature.inferred?.width),
                        isInferredFacility: false,
                        surface: profile.surface?.value ?? 'asphalt',
                        isStandaloneCycleway: isCyclewayFeature,
                        joinType: ribbonOptions.joinType,
                        miterLimit: ribbonOptions.miterLimit,
                        capStart: ribbonOptions.capStart,
                        capEnd: ribbonOptions.capEnd,
                        isClosedLoop: isClosed
                      }
                    })
                  }
                }
              }
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          addFeatureWarning(
            feature,
            `Derived geometry generation failed: ${errMsg}. Displaying source geometry fallback.`
          )
          addFeatureProfileFlag(feature, 'invalid_derived_geometry')
          addFeatureProfileFlag(feature, 'geometry_fallback')
        }

        // If no surface was generated in realistic mode, emit fallback surface using untouched source geometry!
        if (surfaces.length === initialSurfacesCount) {
          const fallbackKind = isCyclewayFeature ? 'cycleway' : isFootwayFeature ? 'sidewalk' : (feature.kind ?? feature.role ?? 'road')
          const fallbackRole = isCyclewayFeature ? 'bike_facility' : isFootwayFeature ? 'sidewalk' : (feature.role ?? 'road')
          const drawOrder = computeDrawOrder({
            layer: effectiveLayer,
            bridge,
            tunnel,
            category: fallbackKind,
            kind: fallbackKind,
            role: fallbackRole
          })

          let fallbackWidth: number | undefined
          let fallbackCorridorWidth: number | undefined
          let fallbackSurfaceVal = 'asphalt'
          let fallbackClass: string | undefined
          try {
            fallbackWidth = feature.roadProfile?.carriagewayWidthMeters?.value
            fallbackCorridorWidth =
              typeof feature.roadProfile?.totalCorridorWidthMeters === 'number'
                ? feature.roadProfile.totalCorridorWidthMeters
                : undefined
            fallbackSurfaceVal = feature.roadProfile?.surface?.value ?? 'asphalt'
            fallbackClass = feature.roadProfile?.highwayClass
          } catch {
            // Ignore errors when reading faulty profile fields during fallback construction
          }

          surfaces.push({
            id: `${feature.id}_fallback`,
            parentFeatureId: feature.id,
            role: fallbackRole,
            kind: fallbackKind,
            viewMode: 'realistic',
            geometry: geom,
            drawOrder,
            properties: {
              layer: effectiveLayer,
              bridge,
              tunnel,
              drawOrder,
              widthMeters: fallbackWidth,
              totalCorridorWidthMeters: fallbackCorridorWidth,
              isPolygon: false,
              isGeometryFallback: true,
              geometryDerivationStatus: 'fallback',
              warnings: feature.warnings,
              isInferredWidth: Boolean(feature.inferred?.width),
              isInferredFacility: false,
              surface: fallbackSurfaceVal,
              highwayClass: fallbackClass,
              isStandaloneCycleway: isCyclewayFeature
            }
          })
        }
      }
      return surfaces
    }

    if (feature.role === 'junction' || feature.kind === 'junction') {
      if (emittedJunctionIds.has(feature.id)) {
        return surfaces
      }
      const drawOrder = computeDrawOrder({
        layer: effectiveLayer,
        category: 'junction_surfaces',
        kind: 'junction_surfaces',
        role: 'junction'
      })
      surfaces.push({
        id: `${feature.id}_junction`,
        parentFeatureId: feature.id,
        role: 'junction',
        kind: 'junction_surfaces',
        viewMode,
        geometry: geom,
        drawOrder,
        properties: {
          layer: effectiveLayer,
          drawOrder,
          isPolygon: geom.type === 'Polygon' || geom.type === 'MultiPolygon',
          ...feature.properties
        }
      })
      return surfaces
    }

    // Default passthrough for other features (retaining geometry without mutation)
    const defaultKind = feature.kind ?? feature.role
    const defaultDrawOrder = computeDrawOrder({
      layer: effectiveLayer,
      category: defaultKind,
      kind: defaultKind,
      role: feature.role
    })
    surfaces.push({
      id: `${feature.id}_default`,
      parentFeatureId: feature.id,
      role: feature.role,
      kind: defaultKind,
      viewMode,
      geometry: geom,
      drawOrder: defaultDrawOrder,
      properties: {
        layer: effectiveLayer,
        drawOrder: defaultDrawOrder,
        isPolygon: geom.type === 'Polygon' || geom.type === 'MultiPolygon',
        ...feature.properties
      }
    })
  return surfaces
}

export function generateViewSurfaces(
  features: EditorFeature[],
  viewMode: ViewMode,
  origin: { lon: number; lat: number },
  junctionGraph?: JunctionTopologyGraph
): ViewSurface[] {
  const surfaces: ViewSurface[] = []

  let junctionPolygonMap = new Map<string, Point2D[][]>()
  let junctionTrimmingMap = new Map<string, Point2D[][]>()
  const emittedJunctionIds = new Set<string>()
  let effectiveJunctionGraph: JunctionTopologyGraph | null = null

  if (viewMode === 'realistic') {
    effectiveJunctionGraph = junctionGraph ?? buildJunctionTopology({ features, origin })
    const junctionGen = generateJunctionSurfaces(effectiveJunctionGraph, origin, features)
    surfaces.push(...junctionGen.junctionSurfaces)
    junctionPolygonMap = junctionGen.junctionPolygonMap
    junctionTrimmingMap = junctionGen.junctionTrimmingMap
    for (const js of junctionGen.junctionSurfaces) {
      emittedJunctionIds.add(js.parentFeatureId)
    }
  }

  const context: FeatureSurfaceContext = {
    junctionPolygonMap,
    junctionTrimmingMap,
    junctionGraph: effectiveJunctionGraph ?? undefined,
    emittedJunctionIds
  }

  for (const feature of features) {
    surfaces.push(...generateSurfacesForFeature(feature, viewMode, origin, context))
  }

  return surfaces
}

/**
 * Derives subordinate overlay features for a single feature.
 */
export function generateSubordinateSurfacesForFeature(
  feature: EditorFeature,
  viewMode: ViewMode
): ViewSurface[] {
  const surfaces: ViewSurface[] = []
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom) return surfaces
  const effectiveLayer = getFeatureEffectiveLayer(feature)

    // 1. Centerlines in realistic mode (in data mode, roads already emit centerline as primary surface)
    if (viewMode === 'realistic' && geom.type === 'LineString') {
      const drawOrder = computeDrawOrder({
        layer: effectiveLayer,
        category: 'centerlines',
        kind: 'centerlines',
        role: feature.role
      })
      surfaces.push({
        id: `${feature.id}_centerline_overlay`,
        parentFeatureId: feature.id,
        role: feature.role,
        kind: 'centerlines',
        viewMode,
        geometry: geom,
        drawOrder,
        properties: {
          layer: effectiveLayer,
          drawOrder,
          isPolygon: false,
          parentKind: feature.kind ?? feature.role
        }
      })
    }

    // 2. Labels
    const labelText =
      (feature.properties?.name as string | undefined) ||
      (feature.properties?.class as string | undefined) ||
      feature.sourceId
    if (labelText) {
      let labelCoord: [number, number] | null = null
      if (geom.type === 'Point') {
        labelCoord = geom.coordinates as [number, number]
      } else if (geom.type === 'LineString' && geom.coordinates.length > 0) {
        const mid = Math.floor(geom.coordinates.length / 2)
        labelCoord = geom.coordinates[mid] as [number, number]
      } else if (geom.type === 'Polygon' && geom.coordinates[0]?.length > 0) {
        const ring = geom.coordinates[0]
        let sumX = 0
        let sumY = 0
        for (let i = 0; i < ring.length - 1; i++) {
          sumX += ring[i][0]
          sumY += ring[i][1]
        }
        const count = ring.length - 1 || 1
        labelCoord = [sumX / count, sumY / count]
      }
      if (labelCoord) {
        const drawOrder = computeDrawOrder({
          layer: effectiveLayer,
          category: 'labels',
          kind: 'labels',
          role: feature.role
        })
        surfaces.push({
          id: `${feature.id}_label`,
          parentFeatureId: feature.id,
          role: feature.role,
          kind: 'labels',
          viewMode,
          geometry: {
            type: 'Point',
            coordinates: labelCoord
          },
          drawOrder,
          properties: {
            layer: effectiveLayer,
            drawOrder,
            text: labelText,
            isPolygon: false,
            parentKind: feature.kind ?? feature.role
          }
        })
      }
    }

    // 3. Vertices (for LineStrings and Polygons)
    if (geom.type === 'LineString') {
      for (let i = 0; i < geom.coordinates.length; i++) {
        const drawOrder = computeDrawOrder({
          layer: effectiveLayer,
          category: 'vertices',
          kind: 'vertices',
          role: feature.role
        })
        surfaces.push({
          id: `${feature.id}_vertex_${i}`,
          parentFeatureId: feature.id,
          role: feature.role,
          kind: 'vertices',
          viewMode,
          geometry: {
            type: 'Point',
            coordinates: geom.coordinates[i]
          },
          drawOrder,
          properties: {
            layer: effectiveLayer,
            drawOrder,
            vertexIndex: i,
            isPolygon: false,
            parentKind: feature.kind ?? feature.role
          }
        })
      }
    } else if (geom.type === 'Polygon' && geom.coordinates[0]) {
      const ring = geom.coordinates[0]
      for (let i = 0; i < ring.length - 1; i++) {
        const drawOrder = computeDrawOrder({
          layer: effectiveLayer,
          category: 'vertices',
          kind: 'vertices',
          role: feature.role
        })
        surfaces.push({
          id: `${feature.id}_vertex_${i}`,
          parentFeatureId: feature.id,
          role: feature.role,
          kind: 'vertices',
          viewMode,
          geometry: {
            type: 'Point',
            coordinates: ring[i]
          },
          drawOrder,
          properties: {
            layer: effectiveLayer,
            drawOrder,
            vertexIndex: i,
            isPolygon: false,
            parentKind: feature.kind ?? feature.role
          }
        })
      }
    }

    // 4. Inference / Warning Overlays
    if (feature.inferred?.width || feature.inferred?.sidewalk || feature.inferred?.bikeLane) {
      const drawOrder = computeDrawOrder({
        layer: effectiveLayer,
        category: 'inference_overlays',
        kind: 'inference_overlays',
        role: feature.role
      })
      surfaces.push({
        id: `${feature.id}_inference_overlay`,
        parentFeatureId: feature.id,
        role: feature.role,
        kind: 'inference_overlays',
        viewMode,
        geometry: geom,
        drawOrder,
        properties: {
          layer: effectiveLayer,
          drawOrder,
          isInferredWidth: Boolean(feature.inferred?.width),
          isInferredSidewalk: Boolean(feature.inferred?.sidewalk),
          isInferredBikeLane: Boolean(feature.inferred?.bikeLane),
          isPolygon: geom.type === 'Polygon' || geom.type === 'MultiPolygon'
        }
      })
    }
    if (feature.warnings && feature.warnings.length > 0) {
      const drawOrder = computeDrawOrder({
        layer: effectiveLayer,
        category: 'warning_overlays',
        kind: 'warning_overlays',
        role: feature.role
      })
      surfaces.push({
        id: `${feature.id}_warning_overlay`,
        parentFeatureId: feature.id,
        role: feature.role,
        kind: 'warning_overlays',
        viewMode,
        geometry: geom,
        drawOrder,
        properties: {
          layer: effectiveLayer,
          drawOrder,
          warnings: feature.warnings,
          warningCount: feature.warnings.length,
          isPolygon: geom.type === 'Polygon' || geom.type === 'MultiPolygon'
        }
      })
    }
  return surfaces
}

export function generateSubordinateSurfaces(
  features: EditorFeature[],
  viewMode: ViewMode
): ViewSurface[] {
  const surfaces: ViewSurface[] = []
  for (const feature of features) {
    surfaces.push(...generateSubordinateSurfacesForFeature(feature, viewMode))
  }
  return surfaces
}
