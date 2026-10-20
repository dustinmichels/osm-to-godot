import ClipperLib from 'clipper-lib'
import {
  Point2D,
  projectToLocalMeters,
  unprojectFromLocalMeters
} from './projection'
import {
  JunctionNode,
  IncidentRoadBranch,
  JunctionTopologyGraph,
  EditorFeature,
  ViewSurface
} from './types'
import {
  unionPolygons,
  differencePolygons,
  cleanPolygonRing,
  ringToIntPath,
  point2DToIntPoint
} from './geometryEngine'
import { generateMetricRibbonPolygon } from './ribbon'
import { computeDrawOrder } from './viewSurfaces'
import { addFeatureWarning } from './geometryWarnings'
export interface JunctionGeometryOptions {
  miterLimit?: number // default 2.5
  maxSetbackMeters?: number // default 20.0
}

/**
 * Checks whether an at-grade junction consists of only 2 branches that are essentially
 * collinear (through-road joint/seam without a turn or intersecting road).
 * Such joints should not have an artificial intersection cutout.
 */
export function isCollinearTwoWay(branches: IncidentRoadBranch[]): boolean {
  if (branches.length !== 2) return false
  let dTheta = Math.abs(branches[0].angleRad - branches[1].angleRad)
  if (dTheta > Math.PI) {
    dTheta = 2 * Math.PI - dTheta
  }
  // If angle difference is within ~4.5 degrees of 180 degrees (collinear through joint)
  return Math.abs(dTheta - Math.PI) < 0.08
}

/**
 * Computes the total length in meters of a road feature polyline.
 */
export function computeFeaturePolylineLength(
  feature: EditorFeature,
  origin: { lon: number; lat: number } = { lon: 0, lat: 0 }
): number {
  const safeOrigin = origin || { lon: 0, lat: 0 }
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) {
    return 0
  }
  const coords = geom.coordinates
  if (coords.length < 2) return 0

  let totalLength = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = projectToLocalMeters(coords[i][0], coords[i][1], safeOrigin.lon, safeOrigin.lat)
    const p2 = projectToLocalMeters(coords[i + 1][0], coords[i + 1][1], safeOrigin.lon, safeOrigin.lat)
    totalLength += Math.hypot(p2.x - p1.x, p2.y - p1.y)
  }
  return totalLength
}

/**
 * Classifies an array of 2D polygon rings into outer boundaries and holes
 * using Clipper winding orientation and point-in-polygon containment.
 */
export function classifyPolygonRings(
  rings: Point2D[][]
): { outer: Point2D[]; holes: Point2D[][] }[] {
  const polylist: { outer: Point2D[]; holes: Point2D[][] }[] = []
  const holeRings: Point2D[][] = []

  for (const ring of rings) {
    if (ring.length < 3) continue
    const path = ringToIntPath(ring)
    if (path.length < 3) continue

    // Positive orientation in Clipper represents outer boundary
    if (ClipperLib.Clipper.Orientation(path)) {
      polylist.push({ outer: ring, holes: [] })
    } else {
      holeRings.push(ring)
    }
  }

  // If orientation was inverted or uniform, fallback to treating all valid rings as outer
  if (polylist.length === 0 && rings.length > 0) {
    return rings
      .filter((r) => r.length >= 3)
      .map((r) => ({ outer: r, holes: [] }))
  }

  // Assign each hole to its enclosing outer polygon
  for (const hole of holeRings) {
    const pt = point2DToIntPoint(hole[0])
    let matched = false
    for (const poly of polylist) {
      const outerPath = ringToIntPath(poly.outer)
      if (ClipperLib.Clipper.PointInPolygon(pt, outerPath) !== 0) {
        poly.holes.push(hole)
        matched = true
        break
      }
    }
    if (!matched && polylist.length > 0) {
      polylist[0].holes.push(hole)
    }
  }

  return polylist
}

/**
 * Converts metric 2D polygon rings to standard GeoJSON Polygon or MultiPolygon geometry.
 */
export function ringsToGeoJsonGeometry(
  rings: Point2D[][],
  origin: { lon: number; lat: number }
): GeoJSON.Geometry {
  if (!rings || rings.length === 0) {
    return { type: 'Polygon', coordinates: [] }
  }

  const unprojectRing = (ring: Point2D[]): number[][] => {
    return ring.map((pt) => {
      const ll = unprojectFromLocalMeters(pt.x, pt.y, origin.lon, origin.lat)
      return [ll.lon, ll.lat]
    })
  }

  const classified = classifyPolygonRings(rings)
  if (classified.length === 0) {
    return { type: 'Polygon', coordinates: [] }
  }

  if (classified.length === 1) {
    const poly = classified[0]
    const coords = [unprojectRing(poly.outer), ...poly.holes.map(unprojectRing)]
    return {
      type: 'Polygon',
      coordinates: coords
    }
  }

  const multiCoords = classified.map((poly) => {
    return [unprojectRing(poly.outer), ...poly.holes.map(unprojectRing)]
  })

  return {
    type: 'MultiPolygon',
    coordinates: multiCoords
  }
}

/**
 * Generates the joined metric 2D surface polygon for an at-grade junction node.
 * Unites incident branch stubs and bounded miter corner wedges into a seamless polygon.
 */
export function generateJunctionPolygon(
  junction: JunctionNode,
  roadLengths?: Map<string, number>,
  options: JunctionGeometryOptions = {}
): Point2D[][] {
  if (!junction.isAtGrade || !Array.isArray(junction.incidentRoads) || junction.incidentRoads.length < 2) {
    return []
  }

  if (isCollinearTwoWay(junction.incidentRoads)) {
    return []
  }

  const P_J = junction.point
  if (!P_J || !Number.isFinite(P_J.x) || !Number.isFinite(P_J.y)) {
    return []
  }

  const miterLimit = options.miterLimit ?? 2.5
  const maxSetbackLimit = options.maxSetbackMeters ?? 20.0

  // Deduplicate branches that share the same feature ID and nearly identical angle
  const deduped: IncidentRoadBranch[] = []
  for (const b of junction.incidentRoads) {
    const exists = deduped.some(
      (d) => d.featureId === b.featureId && Math.abs(d.angleRad - b.angleRad) < 0.05
    )
    if (!exists) {
      deduped.push(b)
    }
  }

  if (deduped.length < 2) {
    return []
  }

  // Sort branches counter-clockwise by angle in [-PI, PI]
  const branches = [...deduped].sort((a, b) => a.angleRad - b.angleRad)
  const N = branches.length

  const branchParams = branches.map((b) => {
    const width = Number.isFinite(b.carriagewayWidth) && b.carriagewayWidth > 0 ? b.carriagewayWidth : 6.0
    const halfWidth = width / 2.0
    const T = b.tangent
    const normal = { x: -T.y, y: T.x } // CCW left normal
    const roadLen = roadLengths?.get(b.featureId) ?? 100.0
    return {
      branch: b,
      width,
      halfWidth,
      T,
      normal,
      roadLen,
      lambdaLeft: 0,
      muRight: 0
    }
  })

  // Compute intersection corners and miter setbacks between adjacent branches
  const corners: { point: Point2D; acute: boolean }[] = []

  for (let i = 0; i < N; i++) {
    const nextIdx = (i + 1) % N
    const A = branchParams[i]
    const B = branchParams[nextIdx]

    let dTheta = B.branch.angleRad - A.branch.angleRad
    while (dTheta <= 0) dTheta += 2 * Math.PI
    while (dTheta > 2 * Math.PI) dTheta -= 2 * Math.PI

    // Intersection between left edge of A and right edge of B:
    // P_J + H_A * N_A + t * T_A = P_J - H_B * N_B + u * T_B
    const D = A.T.y * B.T.x - A.T.x * B.T.y // -sin(dTheta)
    const Rx = -A.halfWidth * A.normal.x - B.halfWidth * B.normal.x
    const Ry = -A.halfWidth * A.normal.y - B.halfWidth * B.normal.y

    if (Math.abs(D) > 1e-4) {
      const t = (Ry * B.T.x - Rx * B.T.y) / D
      const u = (A.T.x * Ry - A.T.y * Rx) / D

      if (t > 0 && u > 0) {
        // Acute or right angle corner between adjacent branches
        const maxDist = miterLimit * Math.max(A.halfWidth, B.halfWidth)
        const tClamped = Math.min(t, maxDist)
        const uClamped = Math.min(u, maxDist)

        const cornerPt: Point2D = {
          x: P_J.x + A.halfWidth * A.normal.x + tClamped * A.T.x,
          y: P_J.y + A.halfWidth * A.normal.y + tClamped * A.T.y
        }
        corners.push({ point: cornerPt, acute: true })
        A.lambdaLeft = Math.max(A.lambdaLeft, tClamped)
        B.muRight = Math.max(B.muRight, uClamped)
      } else {
        // Obtuse or reflex angle between adjacent branches
        const cornerPt: Point2D = {
          x: P_J.x + (A.halfWidth * A.normal.x - B.halfWidth * B.normal.x) / 2,
          y: P_J.y + (A.halfWidth * A.normal.y - B.halfWidth * B.normal.y) / 2
        }
        corners.push({ point: cornerPt, acute: false })
        A.lambdaLeft = Math.max(A.lambdaLeft, B.halfWidth)
        B.muRight = Math.max(B.muRight, A.halfWidth)
      }
    } else {
      // Parallel or near-collinear adjacent branches
      const cornerPt: Point2D = {
        x: P_J.x + A.halfWidth * A.normal.x,
        y: P_J.y + A.halfWidth * A.normal.y
      }
      corners.push({ point: cornerPt, acute: false })
      A.lambdaLeft = Math.max(A.lambdaLeft, B.halfWidth)
      B.muRight = Math.max(B.muRight, A.halfWidth)
    }
  }

  // Calculate final clamped setback distance along each branch
  const setbacks: number[] = branchParams.map((p) => {
    let s = Math.max(p.halfWidth, p.lambdaLeft, p.muRight)
    s = Math.max(s, p.halfWidth)
    s = Math.min(s, maxSetbackLimit)
    s = Math.min(s, 0.45 * p.roadLen)
    return Math.max(s, 0.5)
  })

  // Build branch stubs and corner polygons
  const components: Point2D[][] = []

  for (let i = 0; i < N; i++) {
    const p = branchParams[i]
    const S = setbacks[i]

    // Cut points at setback distance along the branch
    const leftCut: Point2D = {
      x: P_J.x + S * p.T.x + p.halfWidth * p.normal.x,
      y: P_J.y + S * p.T.y + p.halfWidth * p.normal.y
    }
    const rightCut: Point2D = {
      x: P_J.x + S * p.T.x - p.halfWidth * p.normal.x,
      y: P_J.y + S * p.T.y - p.halfWidth * p.normal.y
    }
    // Base points at junction node
    const baseLeft: Point2D = {
      x: P_J.x + p.halfWidth * p.normal.x,
      y: P_J.y + p.halfWidth * p.normal.y
    }
    const baseRight: Point2D = {
      x: P_J.x - p.halfWidth * p.normal.x,
      y: P_J.y - p.halfWidth * p.normal.y
    }

    // Branch stub rectangle
    components.push([baseRight, rightCut, leftCut, baseLeft, baseRight])

    // Corner wedge connecting branch i to branch nextIdx
    const nextIdx = (i + 1) % N
    const nextP = branchParams[nextIdx]
    const nextS = setbacks[nextIdx]
    const nextRightCut: Point2D = {
      x: P_J.x + nextS * nextP.T.x - nextP.halfWidth * nextP.normal.x,
      y: P_J.y + nextS * nextP.T.y - nextP.halfWidth * nextP.normal.y
    }

    const c = corners[i]
    components.push([P_J, leftCut, c.point, nextRightCut, P_J])
  }

  // Boolean Union all components to form the seamless intersection polygon
  const united = unionPolygons(components)
  if (united.length === 0) {
    return []
  }

  // Clean each ring and discard sub-millimeter / micro artifacts (< 0.05 m^2)
  const result: Point2D[][] = []
  for (const ring of united) {
    const cleaned = cleanPolygonRing(ring)
    for (const r of cleaned) {
      if (r.length >= 3) {
        result.push(r)
      }
    }
  }

  return result
}

/**
 * Generates the full corridor trimming polygon for an at-grade junction.
 * Unites the base carriageway junction polygon with corridor-width setback stubs
 * so attached sidewalks, bike lanes, and medians terminate squarely at the junction setback
 * without protruding into the intersection or overlapping intersecting carriageways.
 */
export function generateJunctionTrimmingPolygon(
  junction: JunctionNode,
  baseJunctionRings: Point2D[][],
  roadLengths?: Map<string, number>,
  options: JunctionGeometryOptions = {}
): Point2D[][] {
  if (!junction.isAtGrade || !Array.isArray(junction.incidentRoads) || junction.incidentRoads.length < 2) {
    return baseJunctionRings
  }
  if (isCollinearTwoWay(junction.incidentRoads)) {
    return []
  }

  const P_J = junction.point
  if (!P_J || !Number.isFinite(P_J.x) || !Number.isFinite(P_J.y)) {
    return baseJunctionRings
  }

  const deduped: IncidentRoadBranch[] = []
  for (const b of junction.incidentRoads) {
    const exists = deduped.some(
      (d) => d.featureId === b.featureId && Math.abs(d.angleRad - b.angleRad) < 0.05
    )
    if (!exists) deduped.push(b)
  }
  if (deduped.length < 2) return baseJunctionRings

  const maxSetbackLimit = options.maxSetbackMeters ?? 20.0
  const miterLimit = options.miterLimit ?? 2.5

  const branches = [...deduped].sort((a, b) => a.angleRad - b.angleRad)
  const N = branches.length

  const branchParams = branches.map((b) => {
    const width = Number.isFinite(b.carriagewayWidth) && b.carriagewayWidth > 0 ? b.carriagewayWidth : 6.0
    const halfWidth = width / 2.0
    const corridorW = Number.isFinite(b.corridorWidth) && (b.corridorWidth ?? 0) > 0 ? (b.corridorWidth ?? width) : width
    const halfCorridorWidth = Math.max(halfWidth, corridorW / 2.0)
    const T = b.tangent
    const normal = { x: -T.y, y: T.x }
    const roadLen = roadLengths?.get(b.featureId) ?? 100.0
    return {
      branch: b,
      width,
      halfWidth,
      halfCorridorWidth,
      T,
      normal,
      roadLen,
      lambdaLeft: 0,
      muRight: 0
    }
  })

  const hasWiderCorridor = branchParams.some((p) => p.halfCorridorWidth > p.halfWidth + 0.01)
  if (!hasWiderCorridor) {
    return baseJunctionRings
  }

  for (let i = 0; i < N; i++) {
    const nextIdx = (i + 1) % N
    const A = branchParams[i]
    const B = branchParams[nextIdx]

    let dTheta = B.branch.angleRad - A.branch.angleRad
    while (dTheta <= 0) dTheta += 2 * Math.PI
    while (dTheta > 2 * Math.PI) dTheta -= 2 * Math.PI

    const D = A.T.y * B.T.x - A.T.x * B.T.y
    const Rx = -A.halfWidth * A.normal.x - B.halfWidth * B.normal.x
    const Ry = -A.halfWidth * A.normal.y - B.halfWidth * B.normal.y

    if (Math.abs(D) > 1e-4) {
      const t = (Ry * B.T.x - Rx * B.T.y) / D
      const u = (A.T.x * Ry - A.T.y * Rx) / D
      if (t > 0 && u > 0) {
        const maxDist = miterLimit * Math.max(A.halfWidth, B.halfWidth)
        A.lambdaLeft = Math.max(A.lambdaLeft, Math.min(t, maxDist))
        B.muRight = Math.max(B.muRight, Math.min(u, maxDist))
      } else {
        A.lambdaLeft = Math.max(A.lambdaLeft, B.halfWidth)
        B.muRight = Math.max(B.muRight, A.halfWidth)
      }
    } else {
      A.lambdaLeft = Math.max(A.lambdaLeft, B.halfWidth)
      B.muRight = Math.max(B.muRight, A.halfWidth)
    }
  }

  const setbacks: number[] = branchParams.map((p) => {
    let s = Math.max(p.halfWidth, p.lambdaLeft, p.muRight)
    s = Math.max(s, p.halfWidth)
    s = Math.min(s, maxSetbackLimit)
    s = Math.min(s, 0.45 * p.roadLen)
    return Math.max(s, 0.5)
  })

  const corridorStubs: Point2D[][] = []
  for (let i = 0; i < N; i++) {
    const p = branchParams[i]
    const S = setbacks[i]
    const H = p.halfCorridorWidth

    const leftCut: Point2D = {
      x: P_J.x + S * p.T.x + H * p.normal.x,
      y: P_J.y + S * p.T.y + H * p.normal.y
    }
    const rightCut: Point2D = {
      x: P_J.x + S * p.T.x - H * p.normal.x,
      y: P_J.y + S * p.T.y - H * p.normal.y
    }
    const baseLeft: Point2D = {
      x: P_J.x + H * p.normal.x,
      y: P_J.y + H * p.normal.y
    }
    const baseRight: Point2D = {
      x: P_J.x - H * p.normal.x,
      y: P_J.y - H * p.normal.y
    }
    corridorStubs.push([baseRight, rightCut, leftCut, baseLeft, baseRight])
  }

  const allPolys = [...baseJunctionRings, ...corridorStubs]
  const united = unionPolygons(allPolys)
  if (united.length === 0) return baseJunctionRings

  const result: Point2D[][] = []
  for (const ring of united) {
    const cleaned = cleanPolygonRing(ring)
    for (const r of cleaned) {
      if (r.length >= 3) result.push(r)
    }
  }
  return result.length > 0 ? result : baseJunctionRings
}

/**
 * Trims road surface polygon rings by subtracting incident junction polygons using 2D boolean difference.
 */
export function trimRoadSurfacePolygons(
  roadRings: Point2D[][],
  junctionPolygons: Point2D[][]
): Point2D[][] {
  if (!roadRings || roadRings.length === 0) return []
  if (!junctionPolygons || junctionPolygons.length === 0) return roadRings

  const trimmed = differencePolygons(roadRings, junctionPolygons)
  return trimmed.filter((r) => r.length >= 3)
}

export function generateSurfacesForJunction(
  junc: JunctionNode,
  origin: { lon: number; lat: number },
  roadLengths?: Map<string, number>,
  features: EditorFeature[] = [],
  enclosedIslandHoles: Point2D[][] = []
): {
  surfaces: ViewSurface[]
  polygonRings: Point2D[][]
  trimmingRings: Point2D[][]
} {
  const surfaces: ViewSurface[] = []
  let polygonRings: Point2D[][] = []
  let trimmingRings: Point2D[][] = []
  const incidentFeatureIds = Array.from(new Set(junc.incidentRoads.map((b) => b.featureId)))

  try {
    const rings = generateJunctionPolygon(junc, roadLengths)
    if (rings.length === 0) {
      if (!isCollinearTwoWay(junc.incidentRoads) && junc.incidentRoads.length >= 2) {
        const warnMsg = `Incident junction ${junc.id} polygon derivation collapsed. Road surfaces remain untrimmed.`
        for (const featId of incidentFeatureIds) {
          const feat = features.find((f) => f.id === featId)
          if (feat) {
            addFeatureWarning(feat, warnMsg)
          }
        }
        if (!junc.warnings) junc.warnings = []
        junc.warnings.push(`Junction polygon derivation collapsed. Retaining inspectable point geometry.`)
        const drawOrder = computeDrawOrder({
          layer: junc.layer,
          category: 'junction_surfaces',
          kind: 'junction_surfaces',
          role: 'junction'
        })
        surfaces.push({
          id: `${junc.id}_fallback`,
          parentFeatureId: junc.id,
          role: 'junction',
          kind: 'junction_surfaces',
          viewMode: 'realistic',
          geometry: {
            type: 'Point',
            coordinates: [junc.coordinates.lon, junc.coordinates.lat]
          },
          drawOrder,
          properties: {
            junctionId: junc.id,
            sourceType: junc.sourceType,
            sourceId: junc.sourceId,
            layer: junc.layer,
            isAtGrade: true,
            isRoundabout: junc.isRoundabout,
            branchCount: junc.incidentRoads.length,
            incidentFeatureIds,
            isPolygon: false,
            isGeometryFallback: true,
            geometryDerivationStatus: 'fallback',
            drawOrder
          }
        })
      }
      return { surfaces, polygonRings: [], trimmingRings: [] }
    }
    let effectiveRings = rings
    if (junc.isRoundabout && enclosedIslandHoles.length > 0) {
      const carved = differencePolygons(rings, enclosedIslandHoles)
      if (carved.length > 0) {
        effectiveRings = carved
      }
    }
    const trimRings = generateJunctionTrimmingPolygon(junc, effectiveRings, roadLengths)
    polygonRings = effectiveRings
    trimmingRings = trimRings

    const geojsonGeom = ringsToGeoJsonGeometry(effectiveRings, origin)
    const drawOrder = computeDrawOrder({
      layer: junc.layer,
      category: 'junction_surfaces',
      kind: 'junction_surfaces',
      role: 'junction'
    })

    surfaces.push({
      id: `${junc.id}_surface`,
      parentFeatureId: junc.id,
      role: 'junction',
      kind: 'junction_surfaces',
      viewMode: 'realistic',
      geometry: geojsonGeom,
      drawOrder,
      properties: {
        junctionId: junc.id,
        sourceType: junc.sourceType,
        sourceId: junc.sourceId,
        layer: junc.layer,
        isAtGrade: true,
        isRoundabout: junc.isRoundabout,
        branchCount: junc.incidentRoads.length,
        incidentFeatureIds,
        isPolygon: true,
        drawOrder,
        surface: 'asphalt'
      }
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const warnMsg = `Incident junction ${junc.id} polygon derivation failed: ${errMsg}. Road surfaces remain untrimmed.`
    for (const featId of incidentFeatureIds) {
      const feat = features.find((f) => f.id === featId)
      if (feat) {
        addFeatureWarning(feat, warnMsg)
      }
    }
    if (!junc.warnings) junc.warnings = []
    junc.warnings.push(`Junction polygon derivation failed: ${errMsg}. Retaining inspectable point geometry.`)
    const drawOrder = computeDrawOrder({
      layer: junc.layer,
      category: 'junction_surfaces',
      kind: 'junction_surfaces',
      role: 'junction'
    })
    surfaces.push({
      id: `${junc.id}_fallback`,
      parentFeatureId: junc.id,
      role: 'junction',
      kind: 'junction_surfaces',
      viewMode: 'realistic',
      geometry: {
        type: 'Point',
        coordinates: [junc.coordinates.lon, junc.coordinates.lat]
      },
      drawOrder,
      properties: {
        junctionId: junc.id,
        sourceType: junc.sourceType,
        sourceId: junc.sourceId,
        layer: junc.layer,
        isAtGrade: true,
        isRoundabout: junc.isRoundabout,
        branchCount: junc.incidentRoads.length,
        incidentFeatureIds,
        isPolygon: false,
        isGeometryFallback: true,
        geometryDerivationStatus: 'failed',
        drawOrder
      }
    })
  }

  return { surfaces, polygonRings, trimmingRings }
}
/**
 * Generates separate ViewSurface instances for all at-grade junctions in the topology graph.
 * Returns the view surfaces and a map of junction ID to local metric polygon rings.
 */
export function generateJunctionSurfaces(
  graph: JunctionTopologyGraph,
  origin: { lon: number; lat: number },
  features: EditorFeature[] = []
): {
  junctionSurfaces: ViewSurface[]
  junctionPolygonMap: Map<string, Point2D[][]>
  junctionTrimmingMap: Map<string, Point2D[][]>
} {
  const junctionSurfaces: ViewSurface[] = []
  const junctionPolygonMap = new Map<string, Point2D[][]>()
  const junctionTrimmingMap = new Map<string, Point2D[][]>()
  // Pre-calculate feature road lengths for setback bounding
  const roadLengths = new Map<string, number>()
  for (const f of features) {
    if (f.role === 'road' || f.kind === 'road' || f.role === 'carriageway') {
      roadLengths.set(f.id, computeFeaturePolylineLength(f, origin))
    }
  }
  // Collect enclosed hole rings from closed loops/roundabouts so junctions don't fill interior islands
  const enclosedIslandHoles: Point2D[][] = []
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
        const localPts = coords.map(([lon, lat]) => projectToLocalMeters(lon, lat, origin.lon, origin.lat))
        const widthVal = f.roadProfile?.carriagewayWidthMeters?.value ?? 6.0
        const halfW = widthVal / 2.0
        const ribbonRings = generateMetricRibbonPolygon(localPts, halfW, halfW, { isClosedLoop: true, joinType: 'miter' })
        for (const ring of ribbonRings) {
          const path = ringToIntPath(ring)
          if (path.length >= 3 && !ClipperLib.Clipper.Orientation(path)) {
            enclosedIslandHoles.push(ring)
          }
        }
      }
    }
  }


  const atGradeJunctions = graph.getAtGradeJunctions()
  for (const junc of atGradeJunctions) {
    const res = generateSurfacesForJunction(junc, origin, roadLengths, features, enclosedIslandHoles)
    junctionSurfaces.push(...res.surfaces)
    if (res.polygonRings.length > 0) {
      junctionPolygonMap.set(junc.id, res.polygonRings)
    }
    if (res.trimmingRings.length > 0) {
      junctionTrimmingMap.set(junc.id, res.trimmingRings)
    }
  }
  return { junctionSurfaces, junctionPolygonMap, junctionTrimmingMap }
}
