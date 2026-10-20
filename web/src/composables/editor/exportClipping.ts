import type {
  EditorFeature,
  ViewSurface,
  ProjectEnvelope,
  JunctionNode,
  ExportClippingPolicy,
  ExportClippingStats,
  BoundarySpatialRelation,
  BuildingClippingMode
} from './types'
import {
  Point2D,
  projectToLocalMeters,
  unprojectFromLocalMeters
} from './projection'
import {
  intersectPolygons
} from './geometryEngine'
import {
  ringsToGeoJsonGeometry
} from './junctionGeometry'

export const DEFAULT_EXPORT_CLIPPING_POLICY: ExportClippingPolicy = {
  mode: 'clip_to_bounds',
  bufferMarginMeters: 25.0,
  buildingMode: 'keep_intersecting',
  filterOutsideFeatures: true
}

/**
 * Checks whether a single [lon, lat] coordinate is inside or on the boundary of a bounding box.
 */
export function isPointInsideBounds(
  lon: number,
  lat: number,
  bounds: [number, number, number, number],
  marginDegrees = 0
): boolean {
  const [minLon, minLat, maxLon, maxLat] = bounds
  return (
    lon >= minLon - marginDegrees &&
    lon <= maxLon + marginDegrees &&
    lat >= minLat - marginDegrees &&
    lat <= maxLat + marginDegrees
  )
}

/**
 * Recursively extracts all [lon, lat] coordinate pairs from a GeoJSON geometry.
 */
export function extractAllCoordinates(geom: GeoJSON.Geometry | null | undefined): [number, number][] {
  if (!geom) return []
  const coords: [number, number][] = []

  function traverse(node: unknown) {
    if (!Array.isArray(node) || node.length === 0) return
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      coords.push([node[0] as number, node[1] as number])
      return
    }
    for (const child of node) {
      traverse(child)
    }
  }

  if ('coordinates' in geom) {
    traverse(geom.coordinates)
  }
  return coords
}

/**
 * Computes the 2D spatial relation of an EditorFeature relative to a bounding box.
 */
export function getFeatureBoundaryRelation(
  feature: EditorFeature,
  bounds: [number, number, number, number]
): BoundarySpatialRelation {
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom) return 'outside'
  return getGeometryBoundaryRelation(geom, bounds)
}

/**
 * Computes the 2D spatial relation of a ViewSurface relative to a bounding box.
 */
export function getSurfaceBoundaryRelation(
  surface: ViewSurface,
  bounds: [number, number, number, number]
): BoundarySpatialRelation {
  if (!surface.geometry) return 'outside'
  return getGeometryBoundaryRelation(surface.geometry, bounds)
}

/**
 * Computes spatial relationship ('inside', 'cross_boundary', 'outside') for a GeoJSON geometry.
 */
export function getGeometryBoundaryRelation(
  geom: GeoJSON.Geometry,
  bounds: [number, number, number, number]
): BoundarySpatialRelation {
  const coords = extractAllCoordinates(geom)
  if (coords.length === 0) return 'outside'

  let insideCount = 0
  let outsideCount = 0

  for (const [lon, lat] of coords) {
    if (isPointInsideBounds(lon, lat, bounds)) {
      insideCount++
    } else {
      outsideCount++
    }
  }

  if (insideCount > 0 && outsideCount === 0) {
    return 'inside'
  }
  if (insideCount > 0 && outsideCount > 0) {
    return 'cross_boundary'
  }

  // If all points are strictly outside, the geometry might still straddle/cross the box
  if (isGeometryCrossingBox(coords, bounds)) {
    return 'cross_boundary'
  }

  return 'outside'
}

/**
 * Checks if any segment formed by coordinate pairs intersects the bounding box rectangle.
 */
function isGeometryCrossingBox(
  coords: [number, number][],
  bounds: [number, number, number, number]
): boolean {
  if (coords.length < 2) return false
  const [minLon, minLat, maxLon, maxLat] = bounds

  // Quick AABB test of the feature vs bounds
  let fMinLon = Infinity
  let fMaxLon = -Infinity
  let fMinLat = Infinity
  let fMaxLat = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < fMinLon) fMinLon = lon
    if (lon > fMaxLon) fMaxLon = lon
    if (lat < fMinLat) fMinLat = lat
    if (lat > fMaxLat) fMaxLat = lat
  }

  if (fMaxLon < minLon || fMinLon > maxLon || fMaxLat < minLat || fMinLat > maxLat) {
    return false
  }

  // Check segment intersections with box edges
  const boxEdges: [[number, number], [number, number]][] = [
    [[minLon, minLat], [maxLon, minLat]],
    [[maxLon, minLat], [maxLon, maxLat]],
    [[maxLon, maxLat], [minLon, maxLat]],
    [[minLon, maxLat], [minLon, minLat]]
  ]

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i]!
    const p2 = coords[i + 1]!
    for (const [b1, b2] of boxEdges) {
      if (segmentsIntersect(p1, p2, b1, b2)) {
        return true
      }
    }
  }

  return false
}

function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number]
): boolean {
  const ccw = (a: [number, number], b: [number, number], c: [number, number]) => {
    return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0])
  }
  return (
    ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
    ccw(p1, p2, p3) !== ccw(p1, p2, p4)
  )
}

/**
 * Evaluates whether a junction is a boundary junction.
 * A junction is considered a boundary junction if:
 * 1. It is positioned near or on the boundary (within threshold distance in meters), OR
 * 2. Any of its incident road features crosses the boundary.
 */
export function isJunctionAtBoundary(
  junction: JunctionNode,
  bounds: [number, number, number, number],
  thresholdMeters = 20.0,
  origin: { lon: number; lat: number } = { lon: 0, lat: 0 }
): boolean {
  const [minLon, minLat, maxLon, maxLat] = bounds
  const jLon = junction.coordinates.lon
  const jLat = junction.coordinates.lat

  // Convert distance to degrees threshold roughly
  const degLon = thresholdMeters / (111320 * Math.cos((jLat * Math.PI) / 180))
  const degLat = thresholdMeters / 110540

  const nearMinLon = Math.abs(jLon - minLon) <= degLon
  const nearMaxLon = Math.abs(jLon - maxLon) <= degLon
  const nearMinLat = Math.abs(jLat - minLat) <= degLat
  const nearMaxLat = Math.abs(jLat - maxLat) <= degLat

  if (nearMinLon || nearMaxLon || nearMinLat || nearMaxLat) {
    return true
  }

  // Outside the bounds is also a boundary-context junction
  if (!isPointInsideBounds(jLon, jLat, bounds)) {
    return true
  }

  return false
}

/**
 * Verifies that a boundary junction has retained sufficient incident road context
 * outside the selected area to compute accurate incident angles, outward vectors, and setbacks.
 */
export function verifyBoundaryJoinIntegrity(
  junction: JunctionNode,
  featuresMap: Map<string, EditorFeature>,
  bounds: [number, number, number, number]
): {
  isBoundaryJunction: boolean
  totalIncidentBranches: number
  outsideBranchesCount: number
  insideBranchesCount: number
  geometryRetained: boolean
} {
  const isBoundary = isJunctionAtBoundary(junction, bounds)
  let outsideBranchesCount = 0
  let insideBranchesCount = 0

  for (const branch of junction.incidentRoads) {
    const feature = featuresMap.get(branch.featureId)
    if (!feature) continue
    const rel = getFeatureBoundaryRelation(feature, bounds)
    if (rel === 'outside' || rel === 'cross_boundary') {
      outsideBranchesCount++
    } else {
      insideBranchesCount++
    }
  }

  // Retained means all incident branch features are present in the map
  const geometryRetained = junction.incidentRoads.every((b) => featuresMap.has(b.featureId))

  return {
    isBoundaryJunction: isBoundary,
    totalIncidentBranches: junction.incidentRoads.length,
    outsideBranchesCount,
    insideBranchesCount,
    geometryRetained
  }
}

/**
 * Projects bounding box corners to local metric coordinates with optional metric buffer.
 */
export function getMetricBoundsPolygon(
  bounds: [number, number, number, number],
  origin: { lon: number; lat: number },
  bufferMarginMeters = 0
): { ring: Point2D[]; minX: number; minY: number; maxX: number; maxY: number } {
  const [minLon, minLat, maxLon, maxLat] = bounds

  const pSW = projectToLocalMeters(minLon, minLat, origin.lon, origin.lat)
  const pSE = projectToLocalMeters(maxLon, minLat, origin.lon, origin.lat)
  const pNE = projectToLocalMeters(maxLon, maxLat, origin.lon, origin.lat)
  const pNW = projectToLocalMeters(minLon, maxLat, origin.lon, origin.lat)

  const minX = Math.min(pSW.x, pSE.x, pNE.x, pNW.x) - bufferMarginMeters
  const maxX = Math.max(pSW.x, pSE.x, pNE.x, pNW.x) + bufferMarginMeters
  const minY = Math.min(pSW.y, pSE.y, pNE.y, pNW.y) - bufferMarginMeters
  const maxY = Math.max(pSW.y, pSE.y, pNE.y, pNW.y) + bufferMarginMeters

  // Counter-clockwise closed ring
  const ring: Point2D[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
    { x: minX, y: minY }
  ]

  return { ring, minX, minY, maxX, maxY }
}

// Cohen-Sutherland outcodes for 2D line segment clipping
const INSIDE = 0 // 0000
const LEFT = 1 // 0001
const RIGHT = 2 // 0010
const BOTTOM = 4 // 0100
const TOP = 8 // 1000

function computeOutCode(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): number {
  let code = INSIDE
  if (x < minX) code |= LEFT
  else if (x > maxX) code |= RIGHT
  if (y < minY) code |= BOTTOM
  else if (y > maxY) code |= TOP
  return code
}

/**
 * Clips a single 2D line segment against a metric bounding box using Cohen-Sutherland.
 */
export function clipSegmentToBox(
  p1: Point2D,
  p2: Point2D,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): [Point2D, Point2D] | null {
  let x0 = p1.x
  let y0 = p1.y
  let x1 = p2.x
  let y1 = p2.y

  let outcode0 = computeOutCode(x0, y0, minX, minY, maxX, maxY)
  let outcode1 = computeOutCode(x1, y1, minX, minY, maxX, maxY)
  let accept = false

  while (true) {
    if (!(outcode0 | outcode1)) {
      // Both points inside box
      accept = true
      break
    } else if (outcode0 & outcode1) {
      // Both points outside box in same region
      break
    } else {
      // At least one point outside
      let x = 0
      let y = 0
      const outcodeOut = outcode1 > outcode0 ? outcode1 : outcode0

      if (outcodeOut & TOP) {
        x = x0 + ((x1 - x0) * (maxY - y0)) / (y1 - y0)
        y = maxY
      } else if (outcodeOut & BOTTOM) {
        x = x0 + ((x1 - x0) * (minY - y0)) / (y1 - y0)
        y = minY
      } else if (outcodeOut & RIGHT) {
        y = y0 + ((y1 - y0) * (maxX - x0)) / (x1 - x0)
        x = maxX
      } else if (outcodeOut & LEFT) {
        y = y0 + ((y1 - y0) * (minX - x0)) / (x1 - x0)
        x = minX
      }

      if (outcodeOut === outcode0) {
        x0 = x
        y0 = y
        outcode0 = computeOutCode(x0, y0, minX, minY, maxX, maxY)
      } else {
        x1 = x
        y1 = y
        outcode1 = computeOutCode(x1, y1, minX, minY, maxX, maxY)
      }
    }
  }

  if (accept) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y1 }
    ]
  }
  return null
}

/**
 * Clips a polyline (array of Point2D) against a metric bounding box.
 * Returns array of clipped polyline segments.
 */
export function clipPolylineToBox(
  pts: Point2D[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): Point2D[][] {
  if (pts.length < 2) return []
  const resultLines: Point2D[][] = []
  let currentLine: Point2D[] = []

  for (let i = 0; i < pts.length - 1; i++) {
    const clipped = clipSegmentToBox(pts[i]!, pts[i + 1]!, minX, minY, maxX, maxY)
    if (clipped) {
      const [cp0, cp1] = clipped
      if (currentLine.length === 0) {
        currentLine.push(cp0, cp1)
      } else {
        const last = currentLine[currentLine.length - 1]!
        if (Math.hypot(last.x - cp0.x, last.y - cp0.y) < 1e-4) {
          currentLine.push(cp1)
        } else {
          resultLines.push(currentLine)
          currentLine = [cp0, cp1]
        }
      }
    } else {
      if (currentLine.length > 0) {
        resultLines.push(currentLine)
        currentLine = []
      }
    }
  }

  if (currentLine.length > 0) {
    resultLines.push(currentLine)
  }

  return resultLines
}

/**
 * Clips a GeoJSON geometry against a bounding box in local metric coordinates.
 */
export function clipSurfaceGeometry(
  geometry: GeoJSON.Geometry,
  bounds: [number, number, number, number],
  origin: { lon: number; lat: number },
  bufferMarginMeters = 0,
  isBuilding = false,
  buildingMode: BuildingClippingMode = 'keep_intersecting'
): { clippedGeometry: GeoJSON.Geometry | null; isClipped: boolean; wasOmitted: boolean } {
  const { ring: boxRing, minX, minY, maxX, maxY } = getMetricBoundsPolygon(
    bounds,
    origin,
    bufferMarginMeters
  )

  const relation = getGeometryBoundaryRelation(geometry, bounds)
  if (relation === 'inside') {
    return { clippedGeometry: geometry, isClipped: false, wasOmitted: false }
  }
  if (relation === 'outside') {
    return { clippedGeometry: null, isClipped: false, wasOmitted: true }
  }

  // Cross-boundary feature handling
  if (isBuilding) {
    if (buildingMode === 'keep_intersecting') {
      return { clippedGeometry: geometry, isClipped: false, wasOmitted: false }
    }
    if (buildingMode === 'centroid_inside') {
      const allCoords = extractAllCoordinates(geometry)
      if (allCoords.length > 0) {
        const avgLon = allCoords.reduce((sum, c) => sum + c[0], 0) / allCoords.length
        const avgLat = allCoords.reduce((sum, c) => sum + c[1], 0) / allCoords.length
        if (isPointInsideBounds(avgLon, avgLat, bounds)) {
          return { clippedGeometry: geometry, isClipped: false, wasOmitted: false }
        }
      }
      return { clippedGeometry: null, isClipped: false, wasOmitted: true }
    }
    // Otherwise falls through to 'clip_footprint'
  }

  // Clip Polygon / MultiPolygon
  if (geometry.type === 'Polygon') {
    const coords = geometry.coordinates
    const subjectRings: Point2D[][] = coords.map((ring) =>
      ring.map(([lon, lat]) => projectToLocalMeters(lon, lat, origin.lon, origin.lat))
    )

    const clippedRings = intersectPolygons(subjectRings, [boxRing])
    if (clippedRings.length === 0) {
      return { clippedGeometry: null, isClipped: false, wasOmitted: true }
    }
    const clippedGeom = ringsToGeoJsonGeometry(clippedRings, origin)
    return { clippedGeometry: clippedGeom, isClipped: true, wasOmitted: false }
  }

  if (geometry.type === 'MultiPolygon') {
    const allClippedRings: Point2D[][] = []
    for (const poly of geometry.coordinates) {
      const subjectRings: Point2D[][] = poly.map((ring) =>
        ring.map(([lon, lat]) => projectToLocalMeters(lon, lat, origin.lon, origin.lat))
      )
      const res = intersectPolygons(subjectRings, [boxRing])
      allClippedRings.push(...res)
    }

    if (allClippedRings.length === 0) {
      return { clippedGeometry: null, isClipped: false, wasOmitted: true }
    }
    const clippedGeom = ringsToGeoJsonGeometry(allClippedRings, origin)
    return { clippedGeometry: clippedGeom, isClipped: true, wasOmitted: false }
  }

  // Clip LineString
  if (geometry.type === 'LineString') {
    const pts = geometry.coordinates.map(([lon, lat]) =>
      projectToLocalMeters(lon, lat, origin.lon, origin.lat)
    )
    const clippedLines = clipPolylineToBox(pts, minX, minY, maxX, maxY)
    if (clippedLines.length === 0) {
      return { clippedGeometry: null, isClipped: false, wasOmitted: true }
    }
    if (clippedLines.length === 1) {
      const unprojected = clippedLines[0]!.map((p) => {
        const ll = unprojectFromLocalMeters(p.x, p.y, origin.lon, origin.lat)
        return [ll.lon, ll.lat]
      })
      return {
        clippedGeometry: { type: 'LineString', coordinates: unprojected },
        isClipped: true,
        wasOmitted: false
      }
    }
    const multiCoords = clippedLines.map((line) =>
      line.map((p) => {
        const ll = unprojectFromLocalMeters(p.x, p.y, origin.lon, origin.lat)
        return [ll.lon, ll.lat]
      })
    )
    return {
      clippedGeometry: { type: 'MultiLineString', coordinates: multiCoords },
      isClipped: true,
      wasOmitted: false
    }
  }

  // MultiLineString
  if (geometry.type === 'MultiLineString') {
    const multiCoords: number[][][] = []
    for (const line of geometry.coordinates) {
      const pts = line.map(([lon, lat]) => projectToLocalMeters(lon, lat, origin.lon, origin.lat))
      const clippedLines = clipPolylineToBox(pts, minX, minY, maxX, maxY)
      for (const cl of clippedLines) {
        multiCoords.push(
          cl.map((p) => {
            const ll = unprojectFromLocalMeters(p.x, p.y, origin.lon, origin.lat)
            return [ll.lon, ll.lat]
          })
        )
      }
    }
    if (multiCoords.length === 0) {
      return { clippedGeometry: null, isClipped: false, wasOmitted: true }
    }
    return {
      clippedGeometry: { type: 'MultiLineString', coordinates: multiCoords },
      isClipped: true,
      wasOmitted: false
    }
  }

  // Fallback for Point / MultiPoint
  return { clippedGeometry: geometry, isClipped: false, wasOmitted: false }
}

/**
 * Applies the export clipping policy to an array of generated ViewSurfaces.
 */
export function applyExportClippingToSurfaces(
  surfaces: ViewSurface[],
  bounds: [number, number, number, number] | undefined,
  origin: { lon: number; lat: number },
  policy: ExportClippingPolicy = DEFAULT_EXPORT_CLIPPING_POLICY
): { surfaces: ViewSurface[]; stats: ExportClippingStats } {
  const stats: ExportClippingStats = {
    totalSurfaces: surfaces.length,
    retainedSurfaces: 0,
    clippedSurfaces: 0,
    omittedSurfaces: 0,
    totalFeatures: 0,
    retainedFeatures: 0,
    crossBoundaryFeatures: 0,
    outsideFeaturesOmitted: 0,
    policyApplied: { ...policy }
  }

  if (!bounds || policy.mode === 'unclipped') {
    stats.retainedSurfaces = surfaces.length
    return {
      surfaces: surfaces.map((s) => ({
        ...s,
        properties: {
          ...s.properties,
          isClipped: false,
          boundaryRelation: bounds ? getSurfaceBoundaryRelation(s, bounds) : 'inside'
        }
      })),
      stats
    }
  }

  const bufferMargin = policy.mode === 'buffer_bounds' ? (policy.bufferMarginMeters ?? 25.0) : 0
  const result: ViewSurface[] = []

  for (const surface of surfaces) {
    const isBuilding = surface.role === 'building' || surface.kind === 'building'
    const relation = getSurfaceBoundaryRelation(surface, bounds)

    if (policy.mode === 'preserve_cross_boundary') {
      if (relation === 'outside') {
        stats.omittedSurfaces++
        continue
      }
      stats.retainedSurfaces++
      result.push({
        ...surface,
        properties: {
          ...surface.properties,
          isClipped: false,
          boundaryRelation: relation
        }
      })
      continue
    }

    // mode is 'clip_to_bounds' or 'buffer_bounds'
    const { clippedGeometry, isClipped, wasOmitted } = clipSurfaceGeometry(
      surface.geometry,
      bounds,
      origin,
      bufferMargin,
      isBuilding,
      policy.buildingMode ?? 'keep_intersecting'
    )

    if (wasOmitted || !clippedGeometry) {
      stats.omittedSurfaces++
      continue
    }

    if (isClipped) {
      stats.clippedSurfaces++
    }
    stats.retainedSurfaces++

    result.push({
      ...surface,
      geometry: clippedGeometry,
      properties: {
        ...surface.properties,
        isClipped,
        boundaryRelation: relation,
        clippingPolicy: policy.mode
      }
    })
  }

  return { surfaces: result, stats }
}

/**
 * Applies the export clipping policy to a ProjectEnvelope, tagging features with
 * boundary relations and filtering features outside the selected bounds if configured.
 */
export function applyExportClippingToEnvelope(
  envelope: ProjectEnvelope,
  policy: ExportClippingPolicy = DEFAULT_EXPORT_CLIPPING_POLICY
): { envelope: ProjectEnvelope; stats: ExportClippingStats } {
  const bounds = envelope.selectedBounds
  const stats: ExportClippingStats = {
    totalSurfaces: 0,
    retainedSurfaces: 0,
    clippedSurfaces: 0,
    omittedSurfaces: 0,
    totalFeatures: envelope.features.length,
    retainedFeatures: 0,
    crossBoundaryFeatures: 0,
    outsideFeaturesOmitted: 0,
    policyApplied: { ...policy }
  }

  if (!bounds || policy.mode === 'unclipped') {
    stats.retainedFeatures = envelope.features.length
    return {
      envelope: {
        ...envelope,
        clipping: {
          policy,
          stats,
          selectedBounds: bounds
        }
      },
      stats
    }
  }

  const retainedFeatures: EditorFeature[] = []

  for (const feature of envelope.features) {
    const rel = getFeatureBoundaryRelation(feature, bounds)
    const isBuilding = feature.role === 'building' || feature.kind === 'building'

    if (rel === 'inside') {
      stats.retainedFeatures++
      retainedFeatures.push({
        ...feature,
        boundaryRelation: 'inside'
      })
      continue
    }

    if (rel === 'cross_boundary') {
      stats.crossBoundaryFeatures++
      stats.retainedFeatures++
      retainedFeatures.push({
        ...feature,
        boundaryRelation: 'cross_boundary'
      })
      continue
    }

    // rel === 'outside'
    if (policy.filterOutsideFeatures) {
      stats.outsideFeaturesOmitted++
    } else {
      stats.retainedFeatures++
      retainedFeatures.push({
        ...feature,
        boundaryRelation: 'outside'
      })
    }
  }

  const updatedEnvelope: ProjectEnvelope = {
    ...envelope,
    features: retainedFeatures,
    editorSettings: {
      ...envelope.editorSettings,
      clippingPolicy: policy
    },
    clipping: {
      policy,
      stats,
      selectedBounds: bounds
    }
  }

  return { envelope: updatedEnvelope, stats }
}
