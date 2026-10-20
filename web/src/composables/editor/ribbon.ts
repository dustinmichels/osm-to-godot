import {
  Point2D,
  LonLat,
  projectToLocalMeters,
  unprojectFromLocalMeters
} from './projection'
import {
  GeometryJoinType,
  GeometryEndType,
  RoadProfile,
  CrossSectionStrip,
  FeatureRole
} from './types'
import { cleanPolygonRing, differencePolygons } from './geometryEngine'

export interface RibbonOffsetOptions {
  joinType?: GeometryJoinType
  miterLimit?: number // default 2.5
  capStart?: GeometryEndType // 'butt' | 'square' | 'round' | 'joined'
  capEnd?: GeometryEndType // 'butt' | 'square' | 'round' | 'joined'
  isClosedLoop?: boolean
  resolveSelfIntersections?: boolean
  numArcSteps?: number
}

export interface GeneratedProfileSurface {
  idSuffix: string
  stripId?: string
  role: FeatureRole
  kind: string
  widthMeters: number
  offsetMeters?: number
  side?: 'left' | 'right' | 'center'
  direction?: 'forward' | 'backward' | 'both'
  surface?: string
  coordinates: number[][][]
  isPolygon: boolean
  isStandaloneCycleway?: boolean
  isOnRoadBikeLane?: boolean
  joinType: GeometryJoinType
  miterLimit: number
  capStart: GeometryEndType
  capEnd: GeometryEndType
  isClosedLoop: boolean
  lateralPlacement?: CrossSectionStrip['lateralPlacement']
  provenance?: string
}


/**
 * Generates 2D metric polygon rings from a reference line in local metric space (meters),
 * with bounded miters, explicit joins (miter, bevel, square, round), and endpoint caps (butt, square, round).
 */
export function generateMetricRibbonPolygon(
  points: Point2D[],
  leftOffsetMeters: number,
  rightOffsetMeters: number,
  options: RibbonOffsetOptions = {}
): Point2D[][] {
  if (!points || points.length < 2) return []

  // Validate offsets: must be finite numbers, and total width (left + right) must be positive
  if (
    !Number.isFinite(leftOffsetMeters) ||
    !Number.isFinite(rightOffsetMeters) ||
    leftOffsetMeters + rightOffsetMeters <= 1e-4
  ) {
    return []
  }

  // Filter out any non-finite points and consecutive duplicate points
  const validPoints: Point2D[] = []
  for (const pt of points) {
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      validPoints.push(pt)
    }
  }
  if (validPoints.length < 2) return []

  // Remove consecutive duplicate or near-duplicate vertices (threshold: 0.1 mm)
  const deduped: Point2D[] = [validPoints[0]]
  for (let i = 1; i < validPoints.length; i++) {
    const cur = validPoints[i]
    const prev = deduped[deduped.length - 1]
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 1e-4) {
      deduped.push(cur)
    }
  }
  if (deduped.length < 2) return []
  const miterLimit = options.miterLimit ?? 2.5
  const joinType: GeometryJoinType = options.joinType ?? 'miter'
  const capStart: GeometryEndType = options.capStart ?? 'butt'
  const capEnd: GeometryEndType = options.capEnd ?? 'butt'
  const numArcSteps = options.numArcSteps ?? 8

  const isClosed =
    options.isClosedLoop ??
    (deduped.length >= 3 &&
      Math.hypot(deduped[0].x - deduped[deduped.length - 1].x, deduped[0].y - deduped[deduped.length - 1].y) < 1e-4)

  if (isClosed) {
    // Closed loop (e.g. roundabout or ring road)
    const ringPts =
      Math.hypot(deduped[0].x - deduped[deduped.length - 1].x, deduped[0].y - deduped[deduped.length - 1].y) < 1e-4
        ? deduped.slice(0, -1)
        : deduped
    const N = ringPts.length
    if (N < 3) return []

    const segT: Point2D[] = []
    const segN: Point2D[] = []
    for (let i = 0; i < N; i++) {
      const p1 = ringPts[i]
      const p2 = ringPts[(i + 1) % N]
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const len = Math.hypot(dx, dy) || 1
      segT.push({ x: dx / len, y: dy / len })
      segN.push({ x: -dy / len, y: dx / len })
    }

    const leftLoop: Point2D[] = []
    const rightLoop: Point2D[] = []
    for (let i = 0; i < N; i++) {
      const prev = (i - 1 + N) % N
      const nPrev = segN[prev]
      const nNext = segN[i]
      const sumX = nPrev.x + nNext.x
      const sumY = nPrev.y + nNext.y
      const sumL = Math.hypot(sumX, sumY)
      const M = sumL > 1e-4 ? { x: sumX / sumL, y: sumY / sumL } : nPrev
      const dot = M.x * nPrev.x + M.y * nPrev.y
      const mScale = Math.min(1.0 / Math.max(0.001, dot), miterLimit)

      leftLoop.push({
        x: ringPts[i].x + M.x * mScale * leftOffsetMeters,
        y: ringPts[i].y + M.y * mScale * leftOffsetMeters
      })
      rightLoop.push({
        x: ringPts[i].x - M.x * mScale * rightOffsetMeters,
        y: ringPts[i].y - M.y * mScale * rightOffsetMeters
      })
    }
    leftLoop.push(leftLoop[0])
    rightLoop.push(rightLoop[0])

    // Signed polygon area helper
    const polygonArea = (r: Point2D[]): number => {
      let a = 0
      for (let i = 0; i < r.length - 1; i++) {
        a += r[i].x * r[i + 1].y - r[i + 1].x * r[i].y
      }
      return Math.abs(a) / 2
    }

    const leftArea = polygonArea(leftLoop)
    const rightArea = polygonArea(rightLoop)
    const outer = leftArea >= rightArea ? leftLoop : rightLoop
    const inner = leftArea >= rightArea ? rightLoop : leftLoop

    const diff = differencePolygons([outer], [inner])
    return diff.length > 0 ? diff : [outer]
  }

  // Open polyline
  const n = deduped.length
  const segT: Point2D[] = []
  const segN: Point2D[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = deduped[i + 1].x - deduped[i].x
    const dy = deduped[i + 1].y - deduped[i].y
    const len = Math.hypot(dx, dy) || 1
    segT.push({ x: dx / len, y: dy / len })
    segN.push({ x: -dy / len, y: dx / len })
  }

  const leftPoints: Point2D[] = []
  const rightPoints: Point2D[] = []

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      leftPoints.push({
        x: deduped[0].x + segN[0].x * leftOffsetMeters,
        y: deduped[0].y + segN[0].y * leftOffsetMeters
      })
      rightPoints.push({
        x: deduped[0].x - segN[0].x * rightOffsetMeters,
        y: deduped[0].y - segN[0].y * rightOffsetMeters
      })
      continue
    }

    if (i === n - 1) {
      const last = n - 2
      leftPoints.push({
        x: deduped[n - 1].x + segN[last].x * leftOffsetMeters,
        y: deduped[n - 1].y + segN[last].y * leftOffsetMeters
      })
      rightPoints.push({
        x: deduped[n - 1].x - segN[last].x * rightOffsetMeters,
        y: deduped[n - 1].y - segN[last].y * rightOffsetMeters
      })
      continue
    }

    const tPrev = segT[i - 1]
    const nPrev = segN[i - 1]
    const tNext = segT[i]
    const nNext = segN[i]

    const cp = tPrev.x * tNext.y - tPrev.y * tNext.x
    const dotT = tPrev.x * tNext.x + tPrev.y * tNext.y

    if (dotT < -0.999) {
      // 180-degree hairpin turn
      leftPoints.push({
        x: deduped[i].x + nPrev.x * leftOffsetMeters,
        y: deduped[i].y + nPrev.y * leftOffsetMeters
      })
      leftPoints.push({
        x: deduped[i].x + nNext.x * leftOffsetMeters,
        y: deduped[i].y + nNext.y * leftOffsetMeters
      })
      rightPoints.push({
        x: deduped[i].x - nPrev.x * rightOffsetMeters,
        y: deduped[i].y - nPrev.y * rightOffsetMeters
      })
      rightPoints.push({
        x: deduped[i].x - nNext.x * rightOffsetMeters,
        y: deduped[i].y - nNext.y * rightOffsetMeters
      })
      continue
    }

    const sumX = nPrev.x + nNext.x
    const sumY = nPrev.y + nNext.y
    const sumL = Math.hypot(sumX, sumY)
    const M = sumL > 1e-4 ? { x: sumX / sumL, y: sumY / sumL } : nPrev
    const dot = M.x * nPrev.x + M.y * nPrev.y
    const mScale = 1.0 / Math.max(0.001, dot)
    const boundedScale = Math.min(mScale, miterLimit)

    const leftIsInside = cp > 0
    const rightIsInside = cp < 0

    // Left boundary vertices
    if (leftIsInside || Math.abs(cp) <= 1e-5) {
      leftPoints.push({
        x: deduped[i].x + M.x * boundedScale * leftOffsetMeters,
        y: deduped[i].y + M.y * boundedScale * leftOffsetMeters
      })
    } else {
      // Left is outside of corner
      if (joinType === 'miter' && mScale <= miterLimit) {
        leftPoints.push({
          x: deduped[i].x + M.x * boundedScale * leftOffsetMeters,
          y: deduped[i].y + M.y * boundedScale * leftOffsetMeters
        })
      } else if (joinType === 'round') {
        const steps = 4
        const aIn = Math.atan2(nPrev.y, nPrev.x)
        let diff = Math.atan2(nNext.y, nNext.x) - aIn
        while (diff < -Math.PI) diff += 2 * Math.PI
        while (diff > Math.PI) diff -= 2 * Math.PI
        for (let s = 0; s <= steps; s++) {
          const ang = aIn + diff * (s / steps)
          leftPoints.push({
            x: deduped[i].x + Math.cos(ang) * leftOffsetMeters,
            y: deduped[i].y + Math.sin(ang) * leftOffsetMeters
          })
        }
      } else if (joinType === 'square') {
        const clampedDot = Math.max(-1, Math.min(1, dotT))
        const ext = Math.abs(leftOffsetMeters) * Math.tan(Math.acos(clampedDot) / 4)
        leftPoints.push({
          x: deduped[i].x + nPrev.x * leftOffsetMeters + tPrev.x * ext,
          y: deduped[i].y + nPrev.y * leftOffsetMeters + tPrev.y * ext
        })
        leftPoints.push({
          x: deduped[i].x + nNext.x * leftOffsetMeters - tNext.x * ext,
          y: deduped[i].y + nNext.y * leftOffsetMeters - tNext.y * ext
        })
      } else {
        // Bevel join or clamped miter cutoff
        leftPoints.push({
          x: deduped[i].x + nPrev.x * leftOffsetMeters,
          y: deduped[i].y + nPrev.y * leftOffsetMeters
        })
        leftPoints.push({
          x: deduped[i].x + nNext.x * leftOffsetMeters,
          y: deduped[i].y + nNext.y * leftOffsetMeters
        })
      }
    }

    // Right boundary vertices
    if (rightIsInside || Math.abs(cp) <= 1e-5) {
      rightPoints.push({
        x: deduped[i].x - M.x * boundedScale * rightOffsetMeters,
        y: deduped[i].y - M.y * boundedScale * rightOffsetMeters
      })
    } else {
      // Right is outside of corner
      if (joinType === 'miter' && mScale <= miterLimit) {
        rightPoints.push({
          x: deduped[i].x - M.x * boundedScale * rightOffsetMeters,
          y: deduped[i].y - M.y * boundedScale * rightOffsetMeters
        })
      } else if (joinType === 'round') {
        const steps = 4
        const aIn = Math.atan2(-nPrev.y, -nPrev.x)
        let diff = Math.atan2(-nNext.y, -nNext.x) - aIn
        while (diff < -Math.PI) diff += 2 * Math.PI
        while (diff > Math.PI) diff -= 2 * Math.PI
        for (let s = 0; s <= steps; s++) {
          const ang = aIn + diff * (s / steps)
          rightPoints.push({
            x: deduped[i].x + Math.cos(ang) * rightOffsetMeters,
            y: deduped[i].y + Math.sin(ang) * rightOffsetMeters
          })
        }
      } else if (joinType === 'square') {
        const clampedDot = Math.max(-1, Math.min(1, dotT))
        const ext = Math.abs(rightOffsetMeters) * Math.tan(Math.acos(clampedDot) / 4)
        rightPoints.push({
          x: deduped[i].x - nPrev.x * rightOffsetMeters + tPrev.x * ext,
          y: deduped[i].y - nPrev.y * rightOffsetMeters + tPrev.y * ext
        })
        rightPoints.push({
          x: deduped[i].x - nNext.x * rightOffsetMeters - tNext.x * ext,
          y: deduped[i].y - nNext.y * rightOffsetMeters - tNext.y * ext
        })
      } else {
        // Bevel join or clamped miter cutoff
        rightPoints.push({
          x: deduped[i].x - nPrev.x * rightOffsetMeters,
          y: deduped[i].y - nPrev.y * rightOffsetMeters
        })
        rightPoints.push({
          x: deduped[i].x - nNext.x * rightOffsetMeters,
          y: deduped[i].y - nNext.y * rightOffsetMeters
        })
      }
    }
  }

  // End cap (at vertex n - 1, connecting left boundary to right boundary)
  const endCapPoints: Point2D[] = []
  if (capEnd === 'square' || capEnd === 'round') {
    const last = n - 2
    const tLast = segT[last]
    const nLast = segN[last]
    const vL = leftPoints[leftPoints.length - 1]
    const vR = rightPoints[rightPoints.length - 1]
    const W = Math.hypot(vL.x - vR.x, vL.y - vR.y)
    const E = W / 2.0
    const mEnd = { x: (vL.x + vR.x) / 2, y: (vL.y + vR.y) / 2 }

    if (capEnd === 'square') {
      endCapPoints.push({ x: vL.x + tLast.x * E, y: vL.y + tLast.y * E })
      endCapPoints.push({ x: vR.x + tLast.x * E, y: vR.y + tLast.y * E })
    } else if (capEnd === 'round') {
      const steps = numArcSteps
      for (let j = 1; j < steps; j++) {
        const a = (Math.PI * j) / steps
        endCapPoints.push({
          x: mEnd.x + (nLast.x * Math.cos(a) + tLast.x * Math.sin(a)) * E,
          y: mEnd.y + (nLast.y * Math.cos(a) + tLast.y * Math.sin(a)) * E
        })
      }
    }
  }

  // Start cap (at vertex 0, connecting right boundary back to left boundary)
  const startCapPoints: Point2D[] = []
  if (capStart === 'square' || capStart === 'round') {
    const t0 = segT[0]
    const n0 = segN[0]
    const vL = leftPoints[0]
    const vR = rightPoints[0]
    const W = Math.hypot(vL.x - vR.x, vL.y - vR.y)
    const E = W / 2.0
    const m0 = { x: (vL.x + vR.x) / 2, y: (vL.y + vR.y) / 2 }

    if (capStart === 'square') {
      startCapPoints.push({ x: vR.x - t0.x * E, y: vR.y - t0.y * E })
      startCapPoints.push({ x: vL.x - t0.x * E, y: vL.y - t0.y * E })
    } else if (capStart === 'round') {
      const steps = numArcSteps
      for (let j = 1; j < steps; j++) {
        const a = (Math.PI * j) / steps
        startCapPoints.push({
          x: m0.x + (-n0.x * Math.cos(a) - t0.x * Math.sin(a)) * E,
          y: m0.y + (-n0.y * Math.cos(a) - t0.y * Math.sin(a)) * E
        })
      }
    }
  }

  const rawRing: Point2D[] = [
    ...leftPoints,
    ...endCapPoints,
    ...rightPoints.reverse(),
    ...startCapPoints,
    leftPoints[0]
  ]

  if (options.resolveSelfIntersections !== false) {
    const cleaned = cleanPolygonRing(rawRing)
    return cleaned.length > 0 ? cleaned : [rawRing]
  }

  return [rawRing]
}

/**
 * Generates an offset polyline ribbon (polygon) from a reference line in local metric space,
 * then unprojects back to GeoJSON Polygon coordinates [[lon, lat], ...].
 *
 * @param coordinates Array of [lon, lat] points
 * @param originLon Projection origin longitude
 * @param originLat Projection origin latitude
 * @param leftOffsetMeters Distance from reference line to left edge (positive is to the left)
 * @param rightOffsetMeters Distance from reference line to right edge (positive is to the right)
 * @param options Ribbon options (joinType, miterLimit, capStart, capEnd, isClosedLoop)
 */
export function offsetPolylineToPolygon(
  coordinates: number[][],
  originLon: number,
  originLat: number,
  leftOffsetMeters: number,
  rightOffsetMeters: number,
  options: RibbonOffsetOptions = {}
): number[][][] {
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
    return []
  }

  // Filter valid [lon, lat] pairs
  const validCoords: number[][] = []
  for (const c of coordinates) {
    if (
      Array.isArray(c) &&
      c.length >= 2 &&
      Number.isFinite(c[0]) &&
      Number.isFinite(c[1]) &&
      Math.abs(c[0]) <= 180 &&
      Math.abs(c[1]) <= 90
    ) {
      validCoords.push(c)
    }
  }
  if (validCoords.length < 2) {
    return []
  }

  // Convert reference line to local metric points
  const localPoints: Point2D[] = validCoords.map(([lon, lat]) =>
    projectToLocalMeters(lon, lat, originLon, originLat)
  )
  const metricRings = generateMetricRibbonPolygon(
    localPoints,
    leftOffsetMeters,
    rightOffsetMeters,
    options
  )

  if (metricRings.length === 0) {
    return []
  }

  // Unproject each metric ring back to GeoJSON [lon, lat]
  const geojsonRings: number[][][] = metricRings.map((ring) =>
    ring.map((pt) => {
      const ll: LonLat = unprojectFromLocalMeters(pt.x, pt.y, originLon, originLat)
      return [Number(ll.lon.toFixed(7)), Number(ll.lat.toFixed(7))]
    })
  )

  return geojsonRings
}

/**
 * Generates all carriageway and individual facility strip polygons from a road's effective profile,
 * respecting bounded miters, explicit joins, and endpoint caps.
 */
export function generateProfileSurfacePolygons(params: {
  coordinates: number[][]
  profile: RoadProfile
  originLon: number
  originLat: number
  options?: RibbonOffsetOptions
  isCyclewayFeature?: boolean
  isFootwayFeature?: boolean
}) {
  const { coordinates, profile, originLon, originLat, isCyclewayFeature = false, isFootwayFeature = false } = params
  if (coordinates.length < 2) return []

  const isClosed =
    params.options?.isClosedLoop ??
    (coordinates.length >= 3 &&
      coordinates[0][0] === coordinates[coordinates.length - 1][0] &&
      coordinates[0][1] === coordinates[coordinates.length - 1][1])

  const effectiveOptions: RibbonOffsetOptions = {
    joinType: profile.joinType ?? params.options?.joinType ?? 'miter',
    miterLimit: profile.miterLimit ?? params.options?.miterLimit ?? 2.5,
    capStart: profile.capStart ?? params.options?.capStart ?? 'butt',
    capEnd: profile.capEnd ?? params.options?.capEnd ?? 'butt',
    isClosedLoop: isClosed,
    ...params.options
  }

  const results: GeneratedProfileSurface[] = []

  if (profile.strips && profile.strips.length > 0) {
    let currentOffset = 0
    for (const strip of profile.strips) {
      if (!strip || !Number.isFinite(strip.widthMeters) || strip.widthMeters <= 0) {
        continue
      }
      const halfWidth = strip.widthMeters / 2.0
      const leftOffset = -(strip.offsetMeters ?? currentOffset) + halfWidth
      const rightOffset = (strip.offsetMeters ?? currentOffset) + halfWidth
      const polyCoords = offsetPolylineToPolygon(
        coordinates,
        originLon,
        originLat,
        leftOffset,
        rightOffset,
        effectiveOptions
      )

      if (polyCoords.length > 0) {
        const isStripCycleway =
          strip.kind === 'cycleway' ||
          (isCyclewayFeature && strip.kind === 'carriageway')
        const isStripFootway =
          strip.kind === 'sidewalk' ||
          (isFootwayFeature && strip.kind === 'carriageway')
        const effectiveKind = isStripCycleway ? 'cycleway' : isStripFootway ? 'sidewalk' : strip.kind
        const effectiveRole: FeatureRole = isStripCycleway
          ? 'bike_facility'
          : (isStripFootway || strip.kind === 'sidewalk')
            ? 'sidewalk'
            : strip.kind === 'bike_lane' || strip.kind === 'cycleway'
              ? 'bike_facility'
              : 'road'
        results.push({
          idSuffix: `strip_${strip.id}`,
          stripId: strip.id,
          role: effectiveRole,
          kind: effectiveKind,
          widthMeters: strip.widthMeters,
          offsetMeters: strip.offsetMeters,
          side: strip.side,
          direction: strip.direction,
          surface: strip.surface ?? profile.surface?.value ?? 'asphalt',
          coordinates: polyCoords,
          isPolygon: true,
          isStandaloneCycleway: isStripCycleway,
          isOnRoadBikeLane: strip.kind === 'bike_lane',
          joinType: effectiveOptions.joinType ?? 'miter',
          miterLimit: effectiveOptions.miterLimit ?? 2.5,
          capStart: effectiveOptions.capStart ?? 'butt',
          capEnd: effectiveOptions.capEnd ?? 'butt',
          isClosedLoop: isClosed,
          lateralPlacement: strip.lateralPlacement,
          provenance: strip.provenance
        })
      }
    }
  } else {
    // Default symmetric carriageway
    const widthVal = profile.carriagewayWidthMeters?.value
    if (Number.isFinite(widthVal) && widthVal > 0) {
      const halfWidth = widthVal / 2.0
      const polyCoords = offsetPolylineToPolygon(
        coordinates,
        originLon,
        originLat,
        halfWidth,
        halfWidth,
        effectiveOptions
      )

    if (polyCoords.length > 0) {
      const surfaceKind = isCyclewayFeature ? 'cycleway' : isFootwayFeature ? 'sidewalk' : 'carriageway'
      const surfaceRole = isCyclewayFeature ? 'bike_facility' : isFootwayFeature ? 'sidewalk' : 'road'

      results.push({
        idSuffix: 'carriageway',
        role: surfaceRole,
        kind: surfaceKind,
        widthMeters: profile.carriagewayWidthMeters.value,
        offsetMeters: 0,
        surface: profile.surface?.value ?? 'asphalt',
        coordinates: polyCoords,
        isPolygon: true,
        isStandaloneCycleway: isCyclewayFeature,
        joinType: effectiveOptions.joinType ?? 'miter',
        miterLimit: effectiveOptions.miterLimit ?? 2.5,
        capStart: effectiveOptions.capStart ?? 'butt',
        capEnd: effectiveOptions.capEnd ?? 'butt',
        isClosedLoop: isClosed
      })
    }
    }
  }

  return results
}
