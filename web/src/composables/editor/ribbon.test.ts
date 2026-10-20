import { describe, it, expect } from 'bun:test'
import {
  generateMetricRibbonPolygon,
  offsetPolylineToPolygon,
  generateProfileSurfacePolygons,
  RibbonOffsetOptions
} from './ribbon'
import { Point2D } from './projection'
import { RoadProfile, EditorFeature } from './types'
import { generateViewSurfaces } from './viewSurfaces'

describe('ribbon geometry generator', () => {
  const origin = { lon: -71.11, lat: 42.415 }

  describe('generateMetricRibbonPolygon', () => {
    it('generates symmetric rectangular polygon for straight 2-point line with butt caps', () => {
      const line: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ]
      // 6m wide road (left 3m, right 3m)
      const polygons = generateMetricRibbonPolygon(line, 3.0, 3.0)
      expect(polygons.length).toBe(1)
      const ring = polygons[0]
      expect(ring.length).toBe(5) // 4 corners + 1 closing repeat

      // Bounding coordinates
      const xs = ring.map((p) => p.x)
      const ys = ring.map((p) => p.y)
      expect(Math.min(...xs)).toBeCloseTo(0, 2)
      expect(Math.max(...xs)).toBeCloseTo(10, 2)
      expect(Math.min(...ys)).toBeCloseTo(-3, 2)
      expect(Math.max(...ys)).toBeCloseTo(3, 2)
    })

    it('generates asymmetric strip polygon with lateral center offset', () => {
      const line: Point2D[] = [
        { x: 0, y: 0 },
        { x: 20, y: 0 }
      ]
      // Left sidewalk: width 2m, center offset -4m (left)
      // leftOffset = -(-4) + 1 = 5m, rightOffset = -4 + 1 = -3m
      const polygons = generateMetricRibbonPolygon(line, 5.0, -3.0)
      expect(polygons.length).toBe(1)
      const ring = polygons[0]
      const ys = ring.map((p) => p.y)
      // Strip should strictly lie between y = 3 and y = 5
      expect(Math.min(...ys)).toBeCloseTo(3, 2)
      expect(Math.max(...ys)).toBeCloseTo(5, 2)
    })

    describe('bounded miters', () => {
      it('bounds miter spikes on acute 15-degree hairpin turn', () => {
        const hairpin: Point2D[] = [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 0.5, y: 1.5 }
        ]
        // 6m wide road (half-width 3m). Without bounds, mScale is ~26.0 (spike extends ~78m!)
        const boundedPolygons = generateMetricRibbonPolygon(hairpin, 3.0, 3.0, {
          joinType: 'miter',
          miterLimit: 2.5
        })
        expect(boundedPolygons.length).toBe(1)
        const ring = boundedPolygons[0]
        const xs = ring.map((p) => p.x)
        // With miterLimit 2.5, extension is capped at 3 * 2.5 = 7.5m -> max X <= 27.5
        expect(Math.max(...xs)).toBeLessThan(26)
        expect(Math.min(...xs)).toBeGreaterThan(-5)
      })

      it('respects stricter miter limits', () => {
        const hairpin: Point2D[] = [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 0.5, y: 1.5 }
        ]
        const strictPolygons = generateMetricRibbonPolygon(hairpin, 3.0, 3.0, {
          joinType: 'miter',
          miterLimit: 1.2
        })
        expect(strictPolygons.length).toBe(1)
        const ring = strictPolygons[0]
        const xs = ring.map((p) => p.x)
        expect(Math.max(...xs)).toBeLessThan(24)
      })
    })

    describe('explicit joins', () => {
      const bend90: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ]

      it('supports explicit bevel join', () => {
        const polygons = generateMetricRibbonPolygon(bend90, 3.0, 3.0, {
          joinType: 'bevel'
        })
        expect(polygons.length).toBe(1)
        const ring = polygons[0]
        expect(ring.length).toBeGreaterThanOrEqual(6)
      })

      it('supports explicit square join', () => {
        const polygons = generateMetricRibbonPolygon(bend90, 3.0, 3.0, {
          joinType: 'square'
        })
        expect(polygons.length).toBe(1)
        const ring = polygons[0]
        expect(ring.length).toBeGreaterThanOrEqual(6)
      })

      it('supports explicit round join with intermediate arc points', () => {
        const polygons = generateMetricRibbonPolygon(bend90, 3.0, 3.0, {
          joinType: 'round'
        })
        expect(polygons.length).toBe(1)
        const ring = polygons[0]
        // Round join produces additional arc vertices along the outer turn
        expect(ring.length).toBeGreaterThan(6)
      })
    })

    describe('endpoint caps', () => {
      const line: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ]

      it('supports square endpoint caps extending past endpoints by half-width', () => {
        const polygons = generateMetricRibbonPolygon(line, 3.0, 3.0, {
          capStart: 'square',
          capEnd: 'square'
        })
        expect(polygons.length).toBe(1)
        const ring = polygons[0]
        const xs = ring.map((p) => p.x)
        // With half-width 3m and square caps on both ends:
        // Start extends to x = -3, end extends to x = 13
        expect(Math.min(...xs)).toBeCloseTo(-3, 1)
        expect(Math.max(...xs)).toBeCloseTo(13, 1)
      })

      it('supports round endpoint caps with smooth semicircular arcs', () => {
        const polygons = generateMetricRibbonPolygon(line, 3.0, 3.0, {
          capStart: 'round',
          capEnd: 'round',
          numArcSteps: 8
        })
        expect(polygons.length).toBe(1)
        const ring = polygons[0]
        // Round caps add multiple radial vertices at both ends
        expect(ring.length).toBeGreaterThanOrEqual(16)
        const xs = ring.map((p) => p.x)
        expect(Math.min(...xs)).toBeCloseTo(-3, 1)
        expect(Math.max(...xs)).toBeCloseTo(13, 1)
      })
    })

    describe('closed loop handling', () => {
      it('generates continuous circular ring with outer and inner boundary for closed loop', () => {
        // Circular loop with radius 15m
        const n = 12
        const R = 15
        const loop: Point2D[] = []
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * 2 * Math.PI
          loop.push({ x: R * Math.cos(a), y: R * Math.sin(a) })
        }
        // 6m road (half-width 3m)
        const polygons = generateMetricRibbonPolygon(loop, 3.0, 3.0, {
          isClosedLoop: true
        })
        expect(polygons.length).toBeGreaterThanOrEqual(1)
        // Outer ring
        const outer = polygons[0]
        expect(outer.length).toBeGreaterThanOrEqual(n)
      })
    })
  })

  describe('offsetPolylineToPolygon', () => {
    it('converts geographic coordinates to GeoJSON Polygon rings', () => {
      const coords = [
        [-71.11, 42.415],
        [-71.108, 42.415]
      ]
      const geojsonRings = offsetPolylineToPolygon(
        coords,
        origin.lon,
        origin.lat,
        3.0,
        3.0,
        { joinType: 'miter', capStart: 'butt', capEnd: 'butt' }
      )
      expect(geojsonRings.length).toBe(1)
      expect(geojsonRings[0].length).toBe(5)
      // Check that closing point equals first point
      expect(geojsonRings[0][0][0]).toBe(geojsonRings[0][4][0])
      expect(geojsonRings[0][0][1]).toBe(geojsonRings[0][4][1])
    })
  })

  describe('generateProfileSurfacePolygons', () => {
    it('generates symmetric carriageway polygon from profile without strips', () => {
      const profile: RoadProfile = {
        highwayClass: 'residential',
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
        strips: []
      }
      const coords = [
        [-71.11, 42.415],
        [-71.109, 42.415]
      ]
      const surfaces = generateProfileSurfacePolygons({
        coordinates: coords,
        profile,
        originLon: origin.lon,
        originLat: origin.lat
      })
      expect(surfaces.length).toBe(1)
      expect(surfaces[0].kind).toBe('carriageway')
      expect(surfaces[0].role).toBe('road')
      expect(surfaces[0].widthMeters).toBe(6.0)
      expect(surfaces[0].isPolygon).toBe(true)
      expect(surfaces[0].coordinates.length).toBe(1)
    })

    it('generates individual facility polygons for each strip in a multi-strip profile', () => {
      const profile: RoadProfile = {
        highwayClass: 'secondary',
        carriagewayWidthMeters: { value: 6.0, unit: 'm', provenance: 'source' },
        strips: [
          {
            id: 'sw_l',
            kind: 'sidewalk',
            side: 'left',
            widthMeters: 2.0,
            offsetMeters: -4.0,
            surface: 'concrete'
          },
          {
            id: 'cw',
            kind: 'carriageway',
            side: 'center',
            widthMeters: 6.0,
            offsetMeters: 0.0,
            surface: 'asphalt'
          },
          {
            id: 'bike_r',
            kind: 'bike_lane',
            side: 'right',
            widthMeters: 1.5,
            offsetMeters: 3.75,
            surface: 'asphalt'
          }
        ]
      }
      const coords = [
        [-71.11, 42.415],
        [-71.109, 42.415]
      ]
      const surfaces = generateProfileSurfacePolygons({
        coordinates: coords,
        profile,
        originLon: origin.lon,
        originLat: origin.lat
      })
      expect(surfaces.length).toBe(3)

      const sw = surfaces.find((s) => s.stripId === 'sw_l')
      expect(sw).toBeDefined()
      expect(sw?.role).toBe('sidewalk')
      expect(sw?.kind).toBe('sidewalk')
      expect(sw?.widthMeters).toBe(2.0)
      expect(sw?.side).toBe('left')
      expect(sw?.surface).toBe('concrete')
      expect(sw?.coordinates.length).toBe(1)

      const cw = surfaces.find((s) => s.stripId === 'cw')
      expect(cw).toBeDefined()
      expect(cw?.role).toBe('road')
      expect(cw?.kind).toBe('carriageway')
      expect(cw?.widthMeters).toBe(6.0)
      expect(cw?.side).toBe('center')

      const bike = surfaces.find((s) => s.stripId === 'bike_r')
      expect(bike).toBeDefined()
      expect(bike?.role).toBe('bike_facility')
      expect(bike?.kind).toBe('bike_lane')
      expect(bike?.widthMeters).toBe(1.5)
      expect(bike?.side).toBe('right')
      expect(bike?.isOnRoadBikeLane).toBe(true)
    })
  })

  describe('viewSurfaces integration', () => {
    it('generates realistic view surfaces with explicit joins, miters, and endpoint caps in properties', () => {
      const feature: EditorFeature = {
        id: 'way_100',
        role: 'road',
        kind: 'road',
        sourceId: 'way_100',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [-71.11, 42.415],
            [-71.109, 42.415]
          ]
        },
        properties: {},
        inferred: { width: false, sidewalk: false, bikeLane: false },
        roadProfile: {
          highwayClass: 'primary',
          carriagewayWidthMeters: { value: 7.0, unit: 'm', provenance: 'source' },
          joinType: 'square',
          miterLimit: 2.0,
          capStart: 'butt',
          capEnd: 'square',
          strips: [
            {
              id: 'cw_strip',
              kind: 'carriageway',
              widthMeters: 7.0,
              offsetMeters: 0.0
            }
          ]
        }
      }

      const surfaces = generateViewSurfaces([feature], 'realistic', origin)
      expect(surfaces.length).toBe(1)
      const surface = surfaces[0]
      expect(surface.role).toBe('road')
      expect(surface.geometry.type).toBe('Polygon')
      expect(surface.properties.joinType).toBe('square')
      expect(surface.properties.miterLimit).toBe(2.0)
      expect(surface.properties.capStart).toBe('butt')
      expect(surface.properties.capEnd).toBe('square')
    })
  })
  describe('edge cases and robustness', () => {
    it('handles duplicate consecutive vertices without broken polygons', () => {
      const lineWithDuplicates: Point2D[] = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ]
      const polygons = generateMetricRibbonPolygon(lineWithDuplicates, 3.0, 3.0)
      expect(polygons.length).toBe(1)
      const ring = polygons[0]
      expect(ring.length).toBeGreaterThanOrEqual(5)
      // Check closed ring
      expect(ring[0].x).toBeCloseTo(ring[ring.length - 1].x, 3)
      expect(ring[0].y).toBeCloseTo(ring[ring.length - 1].y, 3)
    })

    it('handles extremely short segments and collapsed lines safely by returning empty or valid polygon', () => {
      const subMillimeterLine: Point2D[] = [
        { x: 0, y: 0 },
        { x: 0.00001, y: 0 }
      ]
      const polygons = generateMetricRibbonPolygon(subMillimeterLine, 3.0, 3.0)
      expect(polygons.length).toBe(0)
    })

    it('rejects invalid, negative, zero, NaN, or infinite widths without crashing', () => {
      const line: Point2D[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ]
      expect(generateMetricRibbonPolygon(line, 0, 0).length).toBe(0)
      expect(generateMetricRibbonPolygon(line, -3, 2).length).toBe(0)
      expect(generateMetricRibbonPolygon(line, NaN, 3).length).toBe(0)
      expect(generateMetricRibbonPolygon(line, 3, Infinity).length).toBe(0)
    })

    it('handles acute hairpins without inverted or broken geometry', () => {
      const hairpin: Point2D[] = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 0, y: 0.1 }
      ]
      const polygons = generateMetricRibbonPolygon(hairpin, 4.0, 4.0, {
        joinType: 'miter',
        miterLimit: 2.5
      })
      expect(polygons.length).toBeGreaterThanOrEqual(1)
      for (const poly of polygons) {
        expect(poly.length).toBeGreaterThanOrEqual(4)
        for (const pt of poly) {
          expect(Number.isFinite(pt.x)).toBe(true)
          expect(Number.isFinite(pt.y)).toBe(true)
        }
      }
    })

    it('resolves self-intersecting centerlines into clean simple polygons', () => {
      const selfIntersectingLine: Point2D[] = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: -5, y: 10 },
        { x: 25, y: 10 }
      ]
      const polygons = generateMetricRibbonPolygon(selfIntersectingLine, 4.0, 4.0)
      expect(polygons.length).toBeGreaterThanOrEqual(1)
      for (const poly of polygons) {
        expect(poly.length).toBeGreaterThanOrEqual(4)
        for (const pt of poly) {
          expect(Number.isFinite(pt.x)).toBe(true)
          expect(Number.isFinite(pt.y)).toBe(true)
        }
      }
    })
  })
})
