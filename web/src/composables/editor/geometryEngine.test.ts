import { describe, it, expect } from 'bun:test'
import {
  inflateMetricPolyline,
  offsetMetricPolygon,
  unionPolygons,
  intersectPolygons,
  differencePolygons,
  cleanPolygonRing,
  point2DToIntPoint,
  intPointToPoint2D
} from './geometryEngine'
import { Point2D } from './projection'

describe('geometryEngine', () => {
  it('converts between Point2D meters and IntPoint millimeters with accuracy', () => {
    const pt: Point2D = { x: 12.345, y: -67.891 }
    const ip = point2DToIntPoint(pt)
    expect(Number(ip.X)).toBe(12345)
    expect(Number(ip.Y)).toBe(-67891)

    const back = intPointToPoint2D(ip)
    expect(back.x).toBeCloseTo(12.345, 3)
    expect(back.y).toBeCloseTo(-67.891, 3)
  })

  describe('sharp bends and hairpins', () => {
    it('bounds miter spikes on acute hairpin bends', () => {
      // 10m road that turns back sharply at a 15-degree acute angle
      const hairpinLine: Point2D[] = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 0.5, y: 1.5 }
      ]

      // Inflate with miter join and default bounded miter limit (2.5)
      const polygons = inflateMetricPolyline(hairpinLine, 4.0, {
        joinType: 'miter',
        miterLimit: 2.5
      })

      expect(polygons.length).toBe(1)
      const ring = polygons[0]
      expect(ring.length).toBeGreaterThan(3)

      // Verify that no vertex explodes past miter limit (e.g. x > 30)
      for (const pt of ring) {
        expect(pt.x).toBeLessThan(26)
        expect(pt.x).toBeGreaterThan(-5)
        expect(pt.y).toBeLessThan(10)
        expect(pt.y).toBeGreaterThan(-5)
      }
    })

    it('cleans self-intersecting ribbons into valid non-self-intersecting polygons', () => {
      // Bowtie / self-intersecting hourglass polygon
      const bowtie: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
        { x: 0, y: 0 }
      ]

      const cleaned = cleanPolygonRing(bowtie)
      expect(cleaned.length).toBe(2)
      // Both lobes should be valid simple polygons meeting at (5, 5)
      for (const ring of cleaned) {
        expect(ring.length).toBeGreaterThanOrEqual(4)
      }
    })
  })

  describe('real junctions', () => {
    it('computes clean union and intersection for 4-way perpendicular cross junction', () => {
      // Road 1: East-West from (-20, 0) to (20, 0), width 6m
      const roadEW = inflateMetricPolyline(
        [{ x: -20, y: 0 }, { x: 20, y: 0 }],
        6.0,
        { endType: 'square' }
      )
      // Road 2: North-South from (0, -20) to (0, 20), width 6m
      const roadNS = inflateMetricPolyline(
        [{ x: 0, y: -20 }, { x: 0, y: 20 }],
        6.0,
        { endType: 'square' }
      )

      expect(roadEW.length).toBe(1)
      expect(roadNS.length).toBe(1)

      // Union combines both road corridors into a single seamless junction footprint
      const union = unionPolygons(roadEW, roadNS)
      expect(union.length).toBe(1)
      // 12-sided cross polygon
      expect(union[0].length).toBeGreaterThanOrEqual(12)

      // Intersection isolates the central junction conflict zone: [-3, 3] x [-3, 3]
      const intersection = intersectPolygons(roadEW, roadNS)
      expect(intersection.length).toBe(1)
      const intRing = intersection[0]
      for (const pt of intRing) {
        expect(Math.abs(pt.x)).toBeLessThanOrEqual(3.05)
        expect(Math.abs(pt.y)).toBeLessThanOrEqual(3.05)
      }
    })

    it('trims incident road at junction boundary using polygon difference (T-junction)', () => {
      // Main street (through road): horizontal [-30, 0] to [30, 0], width 8m (y in [-4, 4])
      const mainStreet = inflateMetricPolyline(
        [{ x: -30, y: 0 }, { x: 30, y: 0 }],
        8.0,
        { endType: 'square' }
      )

      // Side street (terminating at main street): vertical [0, -25] to [0, 0], width 6m
      const sideStreet = inflateMetricPolyline(
        [{ x: 0, y: -25 }, { x: 0, y: 0 }],
        6.0,
        { endType: 'square' }
      )

      // Difference trims the side street so it stops cleanly at the edge of main street (y = -4)
      const trimmedSide = differencePolygons(sideStreet, mainStreet)
      expect(trimmedSide.length).toBe(1)
      for (const pt of trimmedSide[0]) {
        // All vertices of trimmed side street must be at or below y = -4 (subject to 1mm tolerance)
        expect(pt.y).toBeLessThanOrEqual(-3.99)
      }
    })

    it('preserves traffic island cutout inside a roundabout or median using difference', () => {
      // Outer roundabout boundary circle approximated as octagon (radius 15m)
      const outerRing: Point2D[] = []
      const islandRing: Point2D[] = []
      const steps = 16
      for (let i = 0; i < steps; i++) {
        const theta = (i / steps) * 2 * Math.PI
        outerRing.push({ x: 15 * Math.cos(theta), y: 15 * Math.sin(theta) })
        islandRing.push({ x: 8 * Math.cos(theta), y: 8 * Math.sin(theta) })
      }
      outerRing.push({ ...outerRing[0] })
      islandRing.push({ ...islandRing[0] })

      // Carriageway ring is outer circle minus center island
      const carriageway = differencePolygons([outerRing], [islandRing])
      // In 2D polygon representation with hole or outer/inner ring:
      expect(carriageway.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('robustness and edge cases', () => {
    it('handles duplicate consecutive vertices gracefully', () => {
      const duplicatedLine: Point2D[] = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 }
      ]
      const polygons = inflateMetricPolyline(duplicatedLine, 4.0)
      expect(polygons.length).toBe(1)
      expect(polygons[0].length).toBeGreaterThanOrEqual(4)
    })

    it('returns empty array on zero-length or sub-threshold polylines', () => {
      const zeroLine: Point2D[] = [{ x: 5, y: 5 }]
      expect(inflateMetricPolyline(zeroLine, 4.0)).toEqual([])
      expect(inflateMetricPolyline([{ x: 5, y: 5 }, { x: 5, y: 5 }], 4.0)).toEqual([])
    })

    it('returns empty array on non-positive widths', () => {
      const line: Point2D[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
      expect(inflateMetricPolyline(line, 0)).toEqual([])
      expect(inflateMetricPolyline(line, -2)).toEqual([])
    })

    it('offsets closed polygons outward and inward', () => {
      const square: Point2D[] = [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: -5, y: 5 },
        { x: -5, y: -5 }
      ]
      // Outward offset by +2m expands bounds from [-5, 5] to [-7, 7]
      const expanded = offsetMetricPolygon(square, 2.0)
      expect(expanded.length).toBe(1)
      const expMinX = Math.min(...expanded[0].map((p) => p.x))
      const expMaxX = Math.max(...expanded[0].map((p) => p.x))
      const expMinY = Math.min(...expanded[0].map((p) => p.y))
      const expMaxY = Math.max(...expanded[0].map((p) => p.y))
      expect(expMinX).toBeCloseTo(-7.0, 1)
      expect(expMaxX).toBeCloseTo(7.0, 1)
      expect(expMinY).toBeCloseTo(-7.0, 1)
      expect(expMaxY).toBeCloseTo(7.0, 1)

      // Inward offset by -1m shrinks bounds from [-5, 5] to [-4, 4]
      const shrunken = offsetMetricPolygon(square, -1.0)
      expect(shrunken.length).toBe(1)
      const shrMinX = Math.min(...shrunken[0].map((p) => p.x))
      const shrMaxX = Math.max(...shrunken[0].map((p) => p.x))
      const shrMinY = Math.min(...shrunken[0].map((p) => p.y))
      const shrMaxY = Math.max(...shrunken[0].map((p) => p.y))
      expect(shrMinX).toBeCloseTo(-4.0, 1)
      expect(shrMaxX).toBeCloseTo(4.0, 1)
      expect(shrMinY).toBeCloseTo(-4.0, 1)
      expect(shrMaxY).toBeCloseTo(4.0, 1)
    })
  })
})
