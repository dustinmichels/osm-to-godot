import { describe, it, expect } from 'bun:test'
import {
  associateSeparateFacilities,
  evaluatePathToRoadProximity,
  isExplicitSeparateFootway,
  isExplicitSeparateCycleway
} from './facilityAssociation'
import { normalizeOsmPayload } from './normalization'
import type { EditorFeature, RoadProfile } from './types'

describe('facilityAssociation', () => {
  describe('classification helpers', () => {
    it('identifies separate footways from role, kind, and highway tags', () => {
      const sw1: EditorFeature = {
        id: 'sw_1',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '1',
        sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
        properties: { highway: 'footway' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isExplicitSeparateFootway(sw1)).toBe(true)

      const crossing: EditorFeature = {
        id: 'cross_1',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '2',
        sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
        properties: { highway: 'footway', footway: 'crossing' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isExplicitSeparateFootway(crossing)).toBe(false)
    })

    it('identifies separate cycleways from role, kind, and highway tags', () => {
      const cyc1: EditorFeature = {
        id: 'cyc_1',
        role: 'bike_facility',
        kind: 'bike_facility',
        sourceId: '3',
        sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
        properties: { highway: 'cycleway' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isExplicitSeparateCycleway(cyc1)).toBe(true)

      const road: EditorFeature = {
        id: 'road_1',
        role: 'road',
        kind: 'road',
        sourceId: '4',
        sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [0.001, 0]] },
        properties: { highway: 'primary' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }
      expect(isExplicitSeparateCycleway(road)).toBe(false)
    })
  })

  describe('evaluatePathToRoadProximity', () => {
    it('correctly determines parallel distance and side (left vs right)', () => {
      // Road running East-West along y = 0 from x = 0 to x = 100
      // Tangent is (1, 0), so left (+90 deg) is +y, right (-90 deg) is -y
      const roadPts = [
        { x: 0, y: 0 },
        { x: 100, y: 0 }
      ]

      // Left parallel path at y = +5m (left side)
      const leftPath = [
        { x: 0, y: 5 },
        { x: 100, y: 5 }
      ]
      const leftEval = evaluatePathToRoadProximity(leftPath, roadPts, 25.0)
      expect(leftEval.side).toBe('left')
      expect(leftEval.avgDistance).toBeCloseTo(5.0, 1)
      expect(leftEval.parallelFraction).toBeGreaterThan(0.9)
      expect(leftEval.nearFraction).toBe(1.0)

      // Right parallel path at y = -6m (right side)
      const rightPath = [
        { x: 0, y: -6 },
        { x: 100, y: -6 }
      ]
      const rightEval = evaluatePathToRoadProximity(rightPath, roadPts, 25.0)
      expect(rightEval.side).toBe('right')
      expect(rightEval.avgDistance).toBeCloseTo(6.0, 1)
      expect(rightEval.parallelFraction).toBeGreaterThan(0.9)
    })

    it('identifies uncertain side and alignment when path weaves across or is skewed', () => {
      const roadPts = [
        { x: 0, y: 0 },
        { x: 100, y: 0 }
      ]

      // Path that zig-zags from left (+8m) to right (-8m)
      const zigzagPath = [
        { x: 0, y: 8 },
        { x: 50, y: -8 },
        { x: 100, y: 8 }
      ]
      const evalRes = evaluatePathToRoadProximity(zigzagPath, roadPts, 25.0)
      expect(evalRes.side).toBe('uncertain')
    })
  })

  describe('prefer explicit separate footways over duplicate attached facilities', () => {
    it('suppresses inferred attached sidewalk strip when an explicit separate footway runs alongside', () => {
      // Road running East-West with inferred sidewalk strip on left
      const roadFeature: EditorFeature = {
        id: 'road_main',
        role: 'road',
        kind: 'road',
        sourceId: '10',
        sourceGeometry: {
          type: 'LineString',
          // Coordinates at ~origin [0, 0]
          coordinates: [
            [0, 0],
            [0.001, 0] // ~111m East
          ]
        },
        properties: { highway: 'residential', name: 'Main St' },
        roadProfile: {
          highwayClass: 'residential',
          carriagewayWidthMeters: { value: 7.0, provenance: 'class_default', parsedStatus: 'valid' },
          strips: [
            {
              id: 'road_main_sw_l',
              kind: 'sidewalk',
              side: 'left',
              widthMeters: 1.8,
              provenance: 'inferred',
              offsetMeters: -4.4
            },
            {
              id: 'road_main_cw',
              kind: 'carriageway',
              side: 'center',
              widthMeters: 7.0,
              provenance: 'class_default',
              offsetMeters: 0
            }
          ],
          sidewalks: {
            presence: 'present',
            left: true,
            right: false,
            leftPresence: 'present',
            rightPresence: 'absent',
            provenance: 'inferred',
            inferencePolicy: 'urban_defaults'
          }
        },
        inferred: { width: true, sidewalk: true, bikeLane: false }
      }

      // Explicit separate footway running parallel on left side (~5m North, +0.000045 deg lat)
      const separateFootway: EditorFeature = {
        id: 'footway_parallel',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '20',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [0, 0.000045],
            [0.001, 0.000045]
          ]
        },
        properties: { highway: 'footway' },
        roadProfile: {
          highwayClass: 'footway',
          carriagewayWidthMeters: { value: 2.0, provenance: 'class_default', parsedStatus: 'valid' },
          strips: [
            {
              id: 'footway_parallel_footway',
              kind: 'sidewalk',
              side: 'center',
              widthMeters: 2.0,
              provenance: 'class_default',
              offsetMeters: 0
            }
          ]
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const result = associateSeparateFacilities([roadFeature, separateFootway], [0, 0])
      expect(result.associationsCount).toBe(1)
      expect(result.suppressedAttachedCount).toBe(1)

      // Inferred attached sidewalk strip was suppressed from road strips!
      expect(roadFeature.roadProfile?.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
      expect(roadFeature.roadProfile?.sidewalks?.presence).toBe('separate')
      expect(roadFeature.roadProfile?.sidewalks?.left).toBe(false)
      expect(roadFeature.roadProfile?.sidewalks?.leftPresence).toBe('separate')

      // Association is recorded with high confidence
      const assoc = roadFeature.roadProfile?.associatedSeparateFacilities?.[0]
      expect(assoc).toBeDefined()
      expect(assoc?.featureId).toBe('footway_parallel')
      expect(assoc?.side).toBe('left')
      expect(assoc?.confidence).toBe('high')

      // Separate footway remains independent and points back to parent road
      expect(separateFootway.associatedRoadId).toBe('road_main')
      expect(separateFootway.sourceGeometry.coordinates).toEqual([
        [0, 0.000045],
        [0.001, 0.000045]
      ])
    })

    it('flags duplicate_facility_detected when source has attached tags and separate path exists', () => {
      const roadFeature: EditorFeature = {
        id: 'road_tagged',
        role: 'road',
        kind: 'road',
        sourceId: '11',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[0, 0], [0.001, 0]]
        },
        properties: { highway: 'primary', 'sidewalk:left': 'yes' },
        roadProfile: {
          highwayClass: 'primary',
          carriagewayWidthMeters: { value: 8.0, provenance: 'class_default', parsedStatus: 'valid' },
          strips: [
            {
              id: 'road_tagged_sw_l',
              kind: 'sidewalk',
              side: 'left',
              widthMeters: 1.8,
              provenance: 'source',
              offsetMeters: -4.9
            },
            {
              id: 'road_tagged_cw',
              kind: 'carriageway',
              side: 'center',
              widthMeters: 8.0,
              provenance: 'class_default',
              offsetMeters: 0
            }
          ],
          sidewalks: {
            presence: 'present',
            left: true,
            right: false,
            leftPresence: 'present',
            provenance: 'source'
          }
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const separateFootway: EditorFeature = {
        id: 'footway_parallel_2',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '21',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[0, 0.000045], [0.001, 0.000045]]
        },
        properties: { highway: 'footway' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const result = associateSeparateFacilities([roadFeature, separateFootway], [0, 0])
      expect(result.duplicateDetectedCount).toBe(1)
      expect(roadFeature.warnings?.some((w) => w.includes('duplicate attached facility'))).toBe(true)
      expect(roadFeature.roadProfile?.profileFlags).toContain('duplicate_facility_detected')
    })
  })

  describe('flag uncertain association rather than merging nearby lines blindly', () => {
    it('flags uncertain association on both features when sidepath relationship is ambiguous without merging lines', () => {
      const roadFeature: EditorFeature = {
        id: 'road_ambiguous',
        role: 'road',
        kind: 'road',
        sourceId: '12',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[0, 0], [0.001, 0]]
        },
        properties: { highway: 'secondary' },
        roadProfile: {
          highwayClass: 'secondary',
          carriagewayWidthMeters: { value: 7.0, provenance: 'class_default', parsedStatus: 'valid' },
          strips: [
            {
              id: 'road_ambiguous_cw',
              kind: 'carriageway',
              side: 'center',
              widthMeters: 7.0,
              provenance: 'class_default',
              offsetMeters: 0
            }
          ]
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      // Footway at ~20m distance with diagonal / skewed direction (not cleanly parallel sidepath)
      // Lat difference 0.00018 deg ≈ 20 meters North
      const skewedFootway: EditorFeature = {
        id: 'footway_skewed',
        role: 'sidewalk',
        kind: 'sidewalk',
        sourceId: '22',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [
            [0, 0.00018],
            [0.0008, 0.00005] // Angled trajectory toward the road
          ]
        },
        properties: { highway: 'footway' },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      const result = associateSeparateFacilities([roadFeature, skewedFootway], [0, 0])
      expect(result.uncertainCount).toBe(1)

      // Warnings on road feature and separate path
      expect(roadFeature.warnings?.some((w) => w.includes('uncertain sidepath association'))).toBe(true)
      expect(skewedFootway.warnings?.some((w) => w.includes('preserved as independent facility'))).toBe(true)
      expect(roadFeature.roadProfile?.profileFlags).toContain('uncertain_sidepath_association')

      // Record shows confidence 'uncertain'
      const assoc = roadFeature.roadProfile?.associatedSeparateFacilities?.[0]
      expect(assoc?.confidence).toBe('uncertain')

      // CRITICAL INVARIANT: Geometry is NEVER merged or altered blindly!
      expect(skewedFootway.sourceGeometry.coordinates).toEqual([
        [0, 0.00018],
        [0.0008, 0.00005]
      ])
      expect(roadFeature.sourceGeometry.coordinates).toEqual([
        [0, 0],
        [0.001, 0]
      ])
    })
  })

  describe('unlinked separate tags', () => {
    it('flags unlinked_separate_facility when road tags separate but no separate path exists nearby', () => {
      const roadFeature: EditorFeature = {
        id: 'road_unlinked',
        role: 'road',
        kind: 'road',
        sourceId: '13',
        sourceGeometry: {
          type: 'LineString',
          coordinates: [[0, 0], [0.001, 0]]
        },
        properties: { highway: 'primary', 'sidewalk:both': 'separate' },
        roadProfile: {
          highwayClass: 'primary',
          carriagewayWidthMeters: { value: 8.0, provenance: 'class_default', parsedStatus: 'valid' },
          strips: [
            {
              id: 'road_unlinked_cw',
              kind: 'carriageway',
              side: 'center',
              widthMeters: 8.0,
              provenance: 'class_default',
              offsetMeters: 0
            }
          ],
          sidewalks: {
            presence: 'separate',
            left: false,
            right: false,
            leftPresence: 'separate',
            rightPresence: 'separate',
            provenance: 'source'
          }
        },
        inferred: { width: false, sidewalk: false, bikeLane: false }
      }

      associateSeparateFacilities([roadFeature], [0, 0])
      expect(roadFeature.warnings?.some((w) => w.includes('sidewalk=separate, but no corresponding separate footway was identified'))).toBe(true)
      expect(roadFeature.roadProfile?.profileFlags).toContain('unlinked_separate_facility')
    })
  })

  describe('OSM normalization integration with sidewalk:both=separate', () => {
    it('normalizes sidewalk:both=separate as presence: separate without generating duplicate attached strips', () => {
      const osmData = {
        elements: [
          { type: 'node', id: 1, lon: -71.1, lat: 42.4 },
          { type: 'node', id: 2, lon: -71.09, lat: 42.4 },
          {
            type: 'way',
            id: 100,
            nodes: [1, 2],
            tags: {
              highway: 'secondary',
              name: 'Broadway',
              'sidewalk:both': 'separate'
            }
          }
        ]
      }

      const envelope = normalizeOsmPayload(osmData)
      const road = envelope.features.find((f) => f.id === 'osm_w100')
      expect(road).toBeDefined()
      const profile = road?.roadProfile
      expect(profile).toBeDefined()

      // Presence is 'separate'
      expect(profile?.sidewalks?.presence).toBe('separate')
      expect(profile?.sidewalks?.left).toBe(false)
      expect(profile?.sidewalks?.right).toBe(false)

      // No attached sidewalk strips are generated!
      expect(profile?.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
    })
  })
})
