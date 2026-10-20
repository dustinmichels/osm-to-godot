import ClipperLib from 'clipper-lib'
import type {
  EditorFeature,
  ViewSurface,
  ViewMode,
  JunctionTopologyGraph,
  RecomputationStats
} from './types'
import {
  generateSurfacesForFeature,
  generateSubordinateSurfacesForFeature,
  FeatureSurfaceContext
} from './viewSurfaces'
import {
  generateSurfacesForJunction,
  generateJunctionSurfaces,
  computeFeaturePolylineLength
} from './junctionGeometry'
import { generateMetricRibbonPolygon } from './ribbon'
import { Point2D, projectToLocalMeters } from './projection'
import { ringToIntPath } from './geometryEngine'

export interface IncrementalGeometryCache {
  featureSurfaces: Map<string, ViewSurface[]>
  subordinateSurfaces: Map<string, ViewSurface[]>
  junctionSurfaces: Map<string, ViewSurface[]>
  junctionPolygonMap: Map<string, Point2D[][]>
  junctionTrimmingMap: Map<string, Point2D[][]>
  roadLengths: Map<string, number>
  enclosedIslandHoles: Point2D[][]
  featureRevisions: Map<string, string>
  junctionRevisions: Map<string, string>
  lastStats: RecomputationStats | null
}

export function createGeometryCache(): IncrementalGeometryCache {
  return {
    featureSurfaces: new Map(),
    subordinateSurfaces: new Map(),
    junctionSurfaces: new Map(),
    junctionPolygonMap: new Map(),
    junctionTrimmingMap: new Map(),
    roadLengths: new Map(),
    enclosedIslandHoles: [],
    featureRevisions: new Map(),
    junctionRevisions: new Map(),
    lastStats: null
  }
}

export function computeFeatureRevisionKey(
  feature: EditorFeature,
  viewMode: ViewMode,
  origin: { lon: number; lat: number },
  contextRevision?: string
): string {
  const rev = feature.revision ?? 1
  const geomType = (feature.effectiveGeometry || feature.sourceGeometry)?.type ?? 'none'
  const isEff = Boolean(feature.effectiveGeometry)
  let profileKey = ''
  if (feature.roadProfile) {
    const cw = feature.roadProfile.carriagewayWidthMeters?.value ?? 0
    const strips =
      feature.roadProfile.strips?.map((s) => `${s.id}:${s.kind}:${s.widthMeters}:${s.offsetMeters}`).join('|') ?? ''
    profileKey = `rp:${cw}:${strips}:${feature.roadProfile.isRoundabout ?? false}`
  } else if (feature.buildingProfile || feature.properties) {
    const h = feature.buildingProfile?.heightMeters ?? feature.properties?.heightMeters ?? ''
    const l = feature.buildingProfile?.buildingLevels ?? feature.properties?.buildingLevels ?? ''
    profileKey = `bp:${h}:${l}`
  }
  return `${feature.id}|r${rev}|${viewMode}|${origin.lon},${origin.lat}|${geomType}:${isEff}|${profileKey}|${contextRevision ?? ''}`
}

export function computeJunctionRevisionKey(
  juncId: string,
  graph: JunctionTopologyGraph | undefined
): string {
  if (!graph) return ''
  const junc = graph.getJunction(juncId)
  if (!junc) return ''
  const branches = junc.incidentRoads
    .map((b) => `${b.featureId}:${b.carriagewayWidth}:${b.angleRad.toFixed(4)}:${b.layer}`)
    .join('|')
  return `${junc.id}:l${junc.layer}:r${junc.isRoundabout}:b[${branches}]`
}

/**
 * Populates or completely rebuilds the geometry cache for all features and junctions.
 */
export function populateGeometryCache(
  cache: IncrementalGeometryCache,
  features: EditorFeature[],
  viewMode: ViewMode,
  origin?: { lon: number; lat: number },
  junctionGraph?: JunctionTopologyGraph
): void {
  const safeOrigin = origin || { lon: 0, lat: 0 }

  // Clean up features no longer in project
  const currentFeatureIds = new Set(features.map((f) => f.id))
  for (const id of Array.from(cache.featureSurfaces.keys())) {
    if (!currentFeatureIds.has(id)) {
      cache.featureSurfaces.delete(id)
      cache.subordinateSurfaces.delete(id)
      cache.featureRevisions.delete(id)
      cache.roadLengths.delete(id)
    }
  }
  cache.enclosedIslandHoles = []
  // Pre-calculate road lengths
  for (const f of features) {
    if (f.role === 'road' || f.kind === 'road' || f.role === 'carriageway') {
      cache.roadLengths.set(f.id, computeFeaturePolylineLength(f, safeOrigin))
    }
  }

  // Pre-calculate enclosed roundabout island holes
  for (const f of features) {
    const isRoundabout = Boolean(
      f.properties?.junction === 'roundabout' ||
      f.roadProfile?.isRoundabout ||
      f.tags?.junction === 'roundabout'
    )
    const geom = f.effectiveGeometry || f.sourceGeometry
    if (isRoundabout && geom && geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 3) {
      const coords = geom.coordinates as number[][]
      const isClosed =
        coords[0][0] === coords[coords.length - 1][0] &&
        coords[0][1] === coords[coords.length - 1][1]
      if (isClosed) {
        const localPts = coords.map(([lon, lat]) => projectToLocalMeters(lon, lat, safeOrigin.lon, safeOrigin.lat))
        const widthVal = f.roadProfile?.carriagewayWidthMeters?.value ?? 6.0
        const halfW = widthVal / 2.0
        const ribbonRings = generateMetricRibbonPolygon(localPts, halfW, halfW, { isClosedLoop: true, joinType: 'miter' })
        for (const ring of ribbonRings) {
          const path = ringToIntPath(ring)
          if (path.length >= 3 && !ClipperLib.Clipper.Orientation(path)) {
            cache.enclosedIslandHoles.push(ring)
          }
        }
      }
    }
  }

  const emittedJunctionIds = new Set<string>()
  let recomputedJunctionsCount = 0

  if (viewMode === 'realistic' && junctionGraph) {
    const atGradeJunctions = junctionGraph.getAtGradeJunctions()
    const currentJunctionIds = new Set(atGradeJunctions.map((j) => j.id))
    for (const id of Array.from(cache.junctionSurfaces.keys())) {
      if (!currentJunctionIds.has(id)) {
        cache.junctionSurfaces.delete(id)
        cache.junctionPolygonMap.delete(id)
        cache.junctionTrimmingMap.delete(id)
        cache.junctionRevisions.delete(id)
      }
    }

    for (const junc of atGradeJunctions) {
      emittedJunctionIds.add(junc.id)
      const jRev = computeJunctionRevisionKey(junc.id, junctionGraph)
      if (cache.junctionRevisions.get(junc.id) === jRev && cache.junctionSurfaces.has(junc.id)) {
        continue
      }
      recomputedJunctionsCount++
      const jRes = generateSurfacesForJunction(
        junc,
        safeOrigin,
        cache.roadLengths,
        features,
        cache.enclosedIslandHoles
      )
      cache.junctionSurfaces.set(junc.id, jRes.surfaces)
      if (jRes.polygonRings.length > 0) {
        cache.junctionPolygonMap.set(junc.id, jRes.polygonRings)
      } else {
        cache.junctionPolygonMap.delete(junc.id)
      }
      if (jRes.trimmingRings.length > 0) {
        cache.junctionTrimmingMap.set(junc.id, jRes.trimmingRings)
      } else {
        cache.junctionTrimmingMap.delete(junc.id)
      }
      cache.junctionRevisions.set(junc.id, jRev)
    }
  } else {
    cache.junctionSurfaces.clear()
    cache.junctionPolygonMap.clear()
    cache.junctionTrimmingMap.clear()
    cache.junctionRevisions.clear()
  }

  const context: FeatureSurfaceContext = {
    junctionPolygonMap: cache.junctionPolygonMap,
    junctionTrimmingMap: cache.junctionTrimmingMap,
    junctionGraph,
    emittedJunctionIds
  }

  let recomputedFeaturesCount = 0
  let reusedFeaturesCount = 0
  const affectedFeatureIds: string[] = []

  for (const feature of features) {
    let incidentJuncKey = ''
    if (viewMode === 'realistic' && junctionGraph) {
      const juncs = junctionGraph.getJunctionsForFeature(feature.id)
      incidentJuncKey = juncs.map((j) => cache.junctionRevisions.get(j.id) ?? j.id).join(';')
    }
    const featKey = computeFeatureRevisionKey(feature, viewMode, safeOrigin, incidentJuncKey)
    if (cache.featureRevisions.get(feature.id) === featKey && cache.featureSurfaces.has(feature.id)) {
      reusedFeaturesCount++
      continue
    }

    recomputedFeaturesCount++
    affectedFeatureIds.push(feature.id)
    const surfs = generateSurfacesForFeature(feature, viewMode, safeOrigin, context)
    cache.featureSurfaces.set(feature.id, surfs)

    const subSurfs = generateSubordinateSurfacesForFeature(feature, viewMode)
    cache.subordinateSurfaces.set(feature.id, subSurfs)
    cache.featureRevisions.set(feature.id, featKey)
  }

  cache.lastStats = {
    affectedFeatureIds,
    affectedJunctionIds: Array.from(cache.junctionSurfaces.keys()),
    totalFeaturesRecomputed: recomputedFeaturesCount,
    totalJunctionsRecomputed: recomputedJunctionsCount,
    reusedFeaturesCount,
    recomputeType: 'full',
    timestamp: Date.now()
  }
}

/**
 * Recomputes only the geometry affected by a profile edit:
 * - For a building: recomputes only that building's view surface.
 * - For a road: updates adjacent junctions in the graph, recomputes adjacent junction
 *   polygons/trimmings, and recomputes road surfaces for the changed road and its
 *   incident neighbor roads. Unaffected features and junctions are preserved in cache.
 */
export function recomputeAffectedGeometry(
  cache: IncrementalGeometryCache,
  changedFeatureId: string,
  features: EditorFeature[],
  viewMode: ViewMode,
  origin?: { lon: number; lat: number },
  junctionGraph?: JunctionTopologyGraph
): RecomputationStats | null {
  const changedFeature = features.find((f) => f.id === changedFeatureId)
  if (!changedFeature) return null
  const safeOrigin = origin || { lon: 0, lat: 0 }

  // In data view, ribbons and junctions are not rendered. Only the edited feature's line is updated.
  if (viewMode === 'data') {
    const surfs = generateSurfacesForFeature(changedFeature, 'data', safeOrigin)
    cache.featureSurfaces.set(changedFeatureId, surfs)
    const subSurfs = generateSubordinateSurfacesForFeature(changedFeature, 'data')
    cache.subordinateSurfaces.set(changedFeatureId, subSurfs)
    cache.featureRevisions.set(
      changedFeatureId,
      computeFeatureRevisionKey(changedFeature, 'data', safeOrigin)
    )

    const stats: RecomputationStats = {
      affectedFeatureIds: [changedFeatureId],
      affectedJunctionIds: [],
      totalFeaturesRecomputed: 1,
      totalJunctionsRecomputed: 0,
      reusedFeaturesCount: Math.max(0, features.length - 1),
      recomputeType: 'incremental_display',
      timestamp: Date.now()
    }
    cache.lastStats = stats
    return stats
  }

  // Building profile changes: ONLY recompute that building's surfaces
  if (changedFeature.role === 'building' || changedFeature.kind === 'building') {
    const surfs = generateSurfacesForFeature(changedFeature, viewMode, safeOrigin)
    cache.featureSurfaces.set(changedFeatureId, surfs)
    const subSurfs = generateSubordinateSurfacesForFeature(changedFeature, viewMode)
    cache.subordinateSurfaces.set(changedFeatureId, subSurfs)
    cache.featureRevisions.set(
      changedFeatureId,
      computeFeatureRevisionKey(changedFeature, viewMode, safeOrigin)
    )

    const stats: RecomputationStats = {
      affectedFeatureIds: [changedFeatureId],
      affectedJunctionIds: [],
      totalFeaturesRecomputed: 1,
      totalJunctionsRecomputed: 0,
      reusedFeaturesCount: Math.max(0, features.length - 1),
      recomputeType: 'incremental_building',
      timestamp: Date.now()
    }
    cache.lastStats = stats
    return stats
  }
  // Road profile changes:
  // 1. Update polyline length for changed feature
  cache.roadLengths.set(changedFeatureId, computeFeaturePolylineLength(changedFeature, safeOrigin))

  // 2. Update adjacent junctions in the topology graph with new width/corridor properties
  const adjacentJunctionIds: string[] = junctionGraph?.updateFeatureRoadProfile
    ? junctionGraph.updateFeatureRoadProfile(changedFeature)
    : (junctionGraph?.getJunctionsForFeature(changedFeatureId).map((j) => j.id) || [])

  // 3. Recompute adjacent junction polygons and trimming polygons
  for (const jId of adjacentJunctionIds) {
    const junc = junctionGraph?.getJunction(jId)
    if (!junc || !junc.isAtGrade) continue

    const jRes = generateSurfacesForJunction(
      junc,
      safeOrigin,
      cache.roadLengths,
      features,
      cache.enclosedIslandHoles
    )
    cache.junctionSurfaces.set(jId, jRes.surfaces)
    if (jRes.polygonRings.length > 0) {
      cache.junctionPolygonMap.set(jId, jRes.polygonRings)
    } else {
      cache.junctionPolygonMap.delete(jId)
    }
    if (jRes.trimmingRings.length > 0) {
      cache.junctionTrimmingMap.set(jId, jRes.trimmingRings)
    } else {
      cache.junctionTrimmingMap.delete(jId)
    }
    cache.junctionRevisions.set(jId, computeJunctionRevisionKey(jId, junctionGraph))
  }

  // 4. Identify all affected road features: the changed feature PLUS any neighboring
  // road features meeting at the recomputed adjacent junctions (their trimming changed)
  const affectedFeatureIds = new Set<string>([changedFeatureId])
  for (const jId of adjacentJunctionIds) {
    const junc = junctionGraph?.getJunction(jId)
    if (junc) {
      for (const branch of junc.incidentRoads) {
        affectedFeatureIds.add(branch.featureId)
      }
    }
  }

  // 5. Recompute road surfaces ONLY for the affected features
  const emittedJunctionIds = new Set(cache.junctionSurfaces.keys())
  const context: FeatureSurfaceContext = {
    junctionPolygonMap: cache.junctionPolygonMap,
    junctionTrimmingMap: cache.junctionTrimmingMap,
    junctionGraph,
    emittedJunctionIds
  }

  for (const fId of affectedFeatureIds) {
    const feat = features.find((f) => f.id === fId)
    if (feat) {
      const surfs = generateSurfacesForFeature(feat, viewMode, safeOrigin, context)
      cache.featureSurfaces.set(fId, surfs)
      const subSurfs = generateSubordinateSurfacesForFeature(feat, viewMode)
      cache.subordinateSurfaces.set(fId, subSurfs)
      const juncs = junctionGraph?.getJunctionsForFeature(fId) || []
      const incidentJuncKey = juncs.map((j) => cache.junctionRevisions.get(j.id) ?? j.id).join(';')
      cache.featureRevisions.set(
        fId,
        computeFeatureRevisionKey(feat, viewMode, safeOrigin, incidentJuncKey)
      )
    }
  }

  const stats: RecomputationStats = {
    affectedFeatureIds: Array.from(affectedFeatureIds),
    affectedJunctionIds: adjacentJunctionIds,
    totalFeaturesRecomputed: affectedFeatureIds.size,
    totalJunctionsRecomputed: adjacentJunctionIds.length,
    reusedFeaturesCount: Math.max(0, features.length - affectedFeatureIds.size),
    recomputeType: 'incremental_road',
    timestamp: Date.now()
  }
  cache.lastStats = stats
  return stats
}

/**
 * Flattens all cached junction and feature surfaces into a single array.
 */
export function flattenGeometryCache(cache: IncrementalGeometryCache): ViewSurface[] {
  const surfaces: ViewSurface[] = []
  for (const juncSurfs of cache.junctionSurfaces.values()) {
    surfaces.push(...juncSurfs)
  }
  for (const featSurfs of cache.featureSurfaces.values()) {
    surfaces.push(...featSurfs)
  }
  return surfaces
}

/**
 * Flattens all cached subordinate surfaces (centerlines, labels, vertices, overlays) into a single array.
 */
export function flattenSubordinateSurfaces(cache: IncrementalGeometryCache): ViewSurface[] {
  const surfaces: ViewSurface[] = []
  for (const subSurfs of cache.subordinateSurfaces.values()) {
    surfaces.push(...subSurfs)
  }
  return surfaces
}
