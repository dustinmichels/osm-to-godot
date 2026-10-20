import ClipperLib from 'clipper-lib'
import { Point2D } from './projection'

/**
 * Metric geometry engine built on ClipperLib.
 * Uses integer scaling at 1 millimeter precision (scale = 1000)
 * to perform exact, robust 2D metric polygon booleans and offsets
 * in local projection space.
 */

export const METRIC_GEOMETRY_SCALE = 1000.0 // 1 mm per integer unit

export type GeometryJoinType = 'miter' | 'square' | 'bevel' | 'round'
export type GeometryEndType = 'butt' | 'square' | 'round' | 'joined' | 'polygon'

function mapJoinType(join: GeometryJoinType = 'miter'): ClipperLib.JoinType {
  switch (join) {
    case 'square':
      return ClipperLib.JoinType.jtSquare
    case 'round':
      return ClipperLib.JoinType.jtRound
    case 'miter':
    case 'bevel':
    default:
      return ClipperLib.JoinType.jtMiter
  }
}

function mapEndType(end: GeometryEndType = 'square'): ClipperLib.EndType {
  switch (end) {
    case 'butt':
      return ClipperLib.EndType.etOpenButt
    case 'round':
      return ClipperLib.EndType.etOpenRound
    case 'polygon':
      return ClipperLib.EndType.etClosedPolygon
    case 'joined':
      return ClipperLib.EndType.etClosedLine
    case 'square':
    default:
      return ClipperLib.EndType.etOpenSquare
  }
}

/**
 * Converts a Point2D (in meters) to Clipper IntPoint (in integer mm).
 */
export function point2DToIntPoint(pt: Point2D, scale = METRIC_GEOMETRY_SCALE): ClipperLib.IntPoint {
  const x = Number.isFinite(pt.x) ? pt.x : 0
  const y = Number.isFinite(pt.y) ? pt.y : 0
  return { X: Math.round(x * scale), Y: Math.round(y * scale) }
}

/**
 * Converts a Clipper IntPoint back to Point2D (in meters).
 */
export function intPointToPoint2D(pt: ClipperLib.IntPoint, scale = METRIC_GEOMETRY_SCALE): Point2D {
  return {
    x: Number(pt.X) / scale,
    y: Number(pt.Y) / scale
  }
}

/**
 * Converts a polygon ring (closed, last point may equal first) to a non-duplicated IntPath.
 */
export function ringToIntPath(ring: Point2D[], scale = METRIC_GEOMETRY_SCALE): ClipperLib.Path {
  if (ring.length === 0) return []
  const pts: Point2D[] = []
  for (const pt of ring) {
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
      pts.push(pt)
    }
  }
  if (pts.length === 0) return []
  if (
    pts.length > 1 &&
    Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6
  ) {
    pts.pop()
  }
  return pts.map((p) => point2DToIntPoint(p, scale))
}

/**
 * Converts a Clipper Path back to a closed ring (first vertex repeated at the end).
 */
export function intPathToClosedRing(path: ClipperLib.Path, scale = METRIC_GEOMETRY_SCALE): Point2D[] {
  if (path.length === 0) return []
  const pts = path.map((p) => intPointToPoint2D(p, scale))
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) {
    pts.push({ ...first })
  }
  return pts
}

/**
 * Performs a 2D polygon boolean Union on one or more sets of polygon rings.
 * Resolves self-intersections, removes interior edges, and returns clean simple rings.
 */
export function unionPolygons(
  subjectPolygons: Point2D[][],
  clipPolygons: Point2D[][] = [],
  fillType: ClipperLib.PolyFillType = ClipperLib.PolyFillType.pftNonZero
): Point2D[][] {
  const subjects = subjectPolygons.map((r) => ringToIntPath(r)).filter((p) => p.length >= 3)
  const clips = clipPolygons.map((r) => ringToIntPath(r)).filter((p) => p.length >= 3)

  if (subjects.length === 0 && clips.length === 0) return []
  const clipper = new ClipperLib.Clipper()
  if (subjects.length > 0) {
    clipper.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true)
  }
  if (clips.length > 0) {
    clipper.AddPaths(clips, subjects.length === 0 ? ClipperLib.PolyType.ptSubject : ClipperLib.PolyType.ptClip, true)
  }
  const solution: ClipperLib.Paths = []
  clipper.Execute(ClipperLib.ClipType.ctUnion, solution, fillType, fillType)
  return solution.map((p) => intPathToClosedRing(p))
}
/**
 * Performs a 2D polygon boolean Intersection between subject and clip polygon rings.
 */
export function intersectPolygons(
  subjectPolygons: Point2D[][],
  clipPolygons: Point2D[][],
  fillType: ClipperLib.PolyFillType = ClipperLib.PolyFillType.pftNonZero
): Point2D[][] {
  const subjects = subjectPolygons.map((r) => ringToIntPath(r)).filter((p) => p.length >= 3)
  const clips = clipPolygons.map((r) => ringToIntPath(r)).filter((p) => p.length >= 3)

  if (subjects.length === 0 || clips.length === 0) return []
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(clips, ClipperLib.PolyType.ptClip, true)
  const solution: ClipperLib.Paths = []
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, fillType, fillType)
  return solution.map((p) => intPathToClosedRing(p))
}
/**
 * Performs a 2D polygon boolean Difference (subject - clip).
 * Useful for trimming incident roads at junction boundaries and cutting out traffic islands.
 */
export function differencePolygons(
  subjectPolygons: Point2D[][],
  clipPolygons: Point2D[][],
  fillType: ClipperLib.PolyFillType = ClipperLib.PolyFillType.pftNonZero
): Point2D[][] {
  const subjects = subjectPolygons.map((r) => ringToIntPath(r)).filter((p) => p.length >= 3)
  const clips = clipPolygons.map((r) => ringToIntPath(r)).filter((p) => p.length >= 3)

  if (subjects.length === 0) return []
  if (clips.length === 0) return subjectPolygons

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subjects, ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(clips, ClipperLib.PolyType.ptClip, true)
  const solution: ClipperLib.Paths = []
  clipper.Execute(ClipperLib.ClipType.ctDifference, solution, fillType, fillType)
  return solution.map((p) => intPathToClosedRing(p))
}
/**
 * Resolves self-intersections and simplifies a polygon ring into clean simple polygon rings.
 */
export function cleanPolygonRing(
  ring: Point2D[],
  fillType: ClipperLib.PolyFillType = ClipperLib.PolyFillType.pftNonZero
): Point2D[][] {
  if (ring.length < 3) return []
  const path = ringToIntPath(ring)
  if (path.length < 3) return []

  // SimplifyPolygon resolves self-intersections (e.g. figure-8, bowties, self-crossings)
  // and splits them into distinct simple non-self-intersecting polygon rings.
  const simplified = ClipperLib.Clipper.SimplifyPolygon(path, fillType)
  if (simplified && simplified.length > 0) {
    return simplified
      .filter((p: ClipperLib.Path) => p.length >= 3 && Math.abs(ClipperLib.Clipper.Area(p)) > 100) // > 0.0001 m^2
      .map((p: ClipperLib.Path) => intPathToClosedRing(p))
  }

  // Fallback to ClipType.ctUnion
  const clipper = new ClipperLib.Clipper()
  clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true)
  const solution: ClipperLib.Paths = []
  clipper.Execute(ClipperLib.ClipType.ctUnion, solution, fillType, fillType)
  return solution
    .filter((p: ClipperLib.Path) => p.length >= 3 && Math.abs(ClipperLib.Clipper.Area(p)) > 100)
    .map((p: ClipperLib.Path) => intPathToClosedRing(p))
}
export interface MetricPolylineOffsetOptions {
  joinType?: GeometryJoinType
  endType?: GeometryEndType
  miterLimit?: number // default 2.5
}

/**
 * Inflates an open polyline (in meters) by a symmetric total width (or delta).
 * Returns closed polygon rings.
 */
export function inflateMetricPolyline(
  points: Point2D[],
  widthMeters: number,
  options: MetricPolylineOffsetOptions = {}
): Point2D[][] {
  if (points.length < 2 || widthMeters <= 0) return []

  const deduped: Point2D[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const prev = deduped[deduped.length - 1]
    const cur = points[i]
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 1e-4) {
      deduped.push(cur)
    }
  }
  if (deduped.length < 2) return []

  const path = deduped.map((p) => point2DToIntPoint(p))
  const delta = (widthMeters / 2.0) * METRIC_GEOMETRY_SCALE
  const joinType = mapJoinType(options.joinType ?? 'miter')
  const endType = mapEndType(options.endType ?? 'square')
  const miterLimit = options.miterLimit ?? 2.5

  const co = new ClipperLib.ClipperOffset(miterLimit, 0.25)
  co.AddPath(path, joinType, endType)
  const solution: ClipperLib.Paths = []
  co.Execute(solution, delta)
  return solution.map((p) => intPathToClosedRing(p))
}
/**
 * Offsets a closed polygon ring by a metric delta in meters.
 * Positive delta expands; negative delta shrinks/insets.
 */
export function offsetMetricPolygon(
  ring: Point2D[],
  deltaMeters: number,
  options: MetricPolylineOffsetOptions = {}
): Point2D[][] {
  if (ring.length < 3 || Math.abs(deltaMeters) < 1e-6) return ring.length >= 3 ? [ring] : []
  const path = ringToIntPath(ring)
  if (path.length < 3) return []

  const delta = deltaMeters * METRIC_GEOMETRY_SCALE
  const joinType = mapJoinType(options.joinType ?? 'miter')
  const miterLimit = options.miterLimit ?? 2.5

  const co = new ClipperLib.ClipperOffset(miterLimit, 0.25)
  co.AddPath(path, joinType, ClipperLib.EndType.etClosedPolygon)
  const solution: ClipperLib.Paths = []
  co.Execute(solution, delta)
  return solution.map((p) => intPathToClosedRing(p))
}
