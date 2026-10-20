import { describe, it, expect } from 'bun:test'
import {
  isValidCoordinate,
  validateGeometryStructure,
  validateImportPayload,
  validatePositiveWidth,
  validateBuildingLevels,
  validateBuildingHeight,
  validateStripTotals,
  validateRoadLanes,
  validateRoadSpeedLimit,
  validateRoadProperties,
  validateEditorGodotPayload,
  getActionableValidationAdvice,
  EDITOR_SIZE_LIMITS
} from './validation'

describe('validation.ts', () => {
  describe('isValidCoordinate', () => {
    it('validates correct WGS84 coordinates', () => {
      expect(isValidCoordinate(-71.11, 42.41)).toBe(true)
      expect(isValidCoordinate(0, 0)).toBe(true)
      expect(isValidCoordinate(180, 90)).toBe(true)
      expect(isValidCoordinate(-180, -90)).toBe(true)
    })

    it('rejects out of bounds, NaN, or non-number coordinates', () => {
      expect(isValidCoordinate(181, 42)).toBe(false)
      expect(isValidCoordinate(-71, 91)).toBe(false)
      expect(isValidCoordinate(NaN, 42)).toBe(false)
      expect(isValidCoordinate(-71, Infinity)).toBe(false)
      expect(isValidCoordinate('0', 0)).toBe(false)
      expect(isValidCoordinate(null, undefined)).toBe(false)
    })
  })

  describe('validateGeometryStructure', () => {
    it('validates LineString', () => {
      const validLine = {
        type: 'LineString',
        coordinates: [
          [-71.11, 42.41],
          [-71.10, 42.42]
        ]
      }
      expect(validateGeometryStructure(validLine).valid).toBe(true)

      const badLine = {
        type: 'LineString',
        coordinates: [[-71.11, 42.41]]
      }
      expect(validateGeometryStructure(badLine).valid).toBe(false)
    })

    it('validates Polygon', () => {
      const validPoly = {
        type: 'Polygon',
        coordinates: [
          [
            [-71.11, 42.41],
            [-71.10, 42.41],
            [-71.10, 42.42],
            [-71.11, 42.41]
          ]
        ]
      }
      expect(validateGeometryStructure(validPoly).valid).toBe(true)

      const shortPoly = {
        type: 'Polygon',
        coordinates: [
          [
            [-71.11, 42.41],
            [-71.10, 42.41]
          ]
        ]
      }
      expect(validateGeometryStructure(shortPoly).valid).toBe(false)
    })
  })

  describe('validateImportPayload', () => {
    it('rejects null or non-object payloads', () => {
      const res = validateImportPayload(null)
      expect(res.valid).toBe(false)
      expect(res.errors.length).toBeGreaterThan(0)
    })

    it('validates Overture GeoJSON payload and counts categories', () => {
      const payload = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'ov_road_1',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.10, 42.42]
              ]
            },
            properties: {
              overture_type: 'segment',
              class: 'primary'
            }
          },
          {
            type: 'Feature',
            id: 'ov_bldg_1',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-71.11, 42.41],
                  [-71.10, 42.41],
                  [-71.10, 42.42],
                  [-71.11, 42.41]
                ]
              ]
            },
            properties: {
              overture_type: 'building'
            }
          }
        ]
      }

      const res = validateImportPayload(payload)
      expect(res.valid).toBe(true)
      expect(res.source).toBe('overture')
      expect(res.stats.categories.road).toBe(1)
      expect(res.stats.categories.building).toBe(1)
      expect(res.stats.validGeometryCount).toBe(2)
    })

    it('validates raw OSM GeoJSON payload as distinct source-import path', () => {
      const rawOsmGeoJson = {
        type: 'FeatureCollection',
        metadata: {
          source: 'OpenStreetMap',
          generator: 'Overpass Turbo'
        },
        features: [
          {
            type: 'Feature',
            id: 'way/12345',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.11, 42.42]
              ]
            },
            properties: {
              highway: 'secondary',
              name: 'High St',
              lanes: '2'
            }
          },
          {
            type: 'Feature',
            id: 'way/67890',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-71.111, 42.411],
                  [-71.110, 42.411],
                  [-71.110, 42.412],
                  [-71.111, 42.412],
                  [-71.111, 42.411]
                ]
              ]
            },
            properties: {
              building: 'yes',
              'building:levels': '3'
            }
          }
        ]
      }

      const res = validateImportPayload(rawOsmGeoJson)
      expect(res.valid).toBe(true)
      expect(res.source).toBe('osm')
      expect(res.stats.categories.road).toBe(1)
      expect(res.stats.categories.building).toBe(1)
      expect(res.stats.validGeometryCount).toBe(2)
    })

    it('detects invalid coordinates in OSM elements', () => {
      const invalidOsm = {
        elements: [
          {
            type: 'node',
            id: 101,
            lat: 195.0, // invalid latitude!
            lon: -71.11
          }
        ]
      }

      const res = validateImportPayload(invalidOsm)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('invalid coordinates'))).toBe(true)
    })

    it('validates ProjectEnvelope preserving raw properties and unsupported features for round-tripping', () => {
      const projectEnvelope = {
        schemaVersion: '1.0.0',
        sourceMetadata: {
          source: 'osm',
          areaName: 'Test Area'
        },
        projectionOrigin: { lon: -71.11, lat: 42.41 },
        features: [
          {
            id: 'feat_road',
            role: 'road',
            sourceId: 'r1',
            sourceGeometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            },
            properties: { highway: 'primary', maxspeed: '30 mph' },
            inferred: { width: true, sidewalk: true, bikeLane: true }
          },
          {
            id: 'feat_unsupported',
            role: 'unsupported',
            sourceId: 'u99',
            sourceGeometry: {
              type: 'Point',
              coordinates: [-71.1105, 42.4105]
            },
            properties: {
              amenity: 'fountain',
              historic: 'memorial',
              raw_custom_tag: 'preserved_value'
            },
            inferred: { width: false, sidewalk: false, bikeLane: false }
          }
        ]
      }

      const res = validateImportPayload(projectEnvelope)
      expect(res.valid).toBe(true)
      expect(res.source).toBe('osm')
      expect(res.stats.categories.road).toBe(1)
      expect(res.stats.categories.unsupported).toBe(1)
      expect(res.stats.totalFeatures).toBe(2)

      // Verify JSON round-tripping preserves raw custom properties and unsupported role exactly
      const serialized = JSON.stringify(projectEnvelope)
      const roundTripped = JSON.parse(serialized)
      const revalidated = validateImportPayload(roundTripped)
      expect(revalidated.valid).toBe(true)
      expect(roundTripped.features[1].properties.raw_custom_tag).toBe('preserved_value')
      expect(roundTripped.features[1].role).toBe('unsupported')
    })

    it('rejects mixed-source ProjectEnvelope payloads attempting automatic conflation', () => {
      const mixedEnvelope = {
        schemaVersion: '1.0.0',
        sourceMetadata: {
          source: 'osm',
          areaName: 'Mixed Test'
        },
        projectionOrigin: { lon: -71.11, lat: 42.41 },
        features: [
          {
            id: 'feat_osm',
            role: 'road',
            sourceId: 'way/101',
            sourceReference: { type: 'way', id: 101, nodes: [1, 2] },
            sourceGeometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            },
            properties: { highway: 'primary' },
            inferred: { width: true, sidewalk: true, bikeLane: true }
          },
          {
            id: 'feat_overture',
            role: 'building',
            sourceId: 'ov_bldg_999',
            sourceReference: { type: 'overture_building', id: 'ov_bldg_999', overtureId: 'ov_bldg_999' },
            sourceGeometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-71.11, 42.41],
                  [-71.1, 42.41],
                  [-71.1, 42.42],
                  [-71.11, 42.41]
                ]
              ]
            },
            properties: { overture_type: 'building' },
            inferred: { width: false, sidewalk: false, bikeLane: false }
          }
        ]
      }

      const res = validateImportPayload(mixedEnvelope)
      expect(res.valid).toBe(false)
      expect(
        res.errors.some(
          (e) =>
            e.includes('Automatic cross-source conflation is not supported') ||
            e.includes('alternative input sources')
        )
      ).toBe(true)
    })

    it('rejects raw GeoJSON containing mixed OSM and Overture features', () => {
      const mixedGeoJson = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'ov_road_1',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            },
            properties: {
              overture_type: 'segment'
            }
          },
          {
            type: 'Feature',
            id: 'way/555',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            },
            properties: {
              osm_id: 555,
              osm_type: 'way',
              highway: 'secondary'
            }
          }
        ]
      }

      const res = validateImportPayload(mixedGeoJson)
      expect(res.valid).toBe(false)
      expect(
        res.errors.some((e) => e.includes('Automatic cross-source conflation is not supported'))
      ).toBe(true)
    })

    it('rejects unsupported project schema versions rather than interpreting them as ordinary source GeoJSON', () => {
      // 1. Envelope with unsupported schemaVersion '2.0.0'
      const v2Envelope = {
        schemaVersion: '2.0.0',
        sourceMetadata: { source: 'osm', areaName: 'V2 Area' },
        projectionOrigin: { lon: -71.11, lat: 42.41 },
        features: [
          {
            id: 'feat_1',
            role: 'road',
            sourceGeometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            }
          }
        ]
      }
      const res1 = validateImportPayload(v2Envelope)
      expect(res1.valid).toBe(false)
      expect(res1.errors.some((e) => e.includes('Unsupported project schema version') && e.includes('2.0.0'))).toBe(true)
      expect(res1.errors.some((e) => e.includes('Supported schema versions: 1.0.0'))).toBe(true)
      // Must NOT be interpreted as ordinary Overture/source GeoJSON
      expect(res1.source).not.toBe('overture')

      // 2. GeoJSON FeatureCollection with an unsupported schemaVersion: '3.1.0'
      const fcWithBadVersion = {
        type: 'FeatureCollection',
        schemaVersion: '3.1.0',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            },
            properties: {
              highway: 'residential'
            }
          }
        ]
      }
      const res2 = validateImportPayload(fcWithBadVersion)
      expect(res2.valid).toBe(false)
      expect(res2.errors.some((e) => e.includes('Unsupported project schema version') && e.includes('3.1.0'))).toBe(true)
      // Must NOT be treated as raw Overture GeoJSON
      expect(res2.source).not.toBe('overture')

      // 3. Snake_case schema_version with unsupported version '0.9.0'
      const snakeVersionEnvelope = {
        schema_version: '0.9.0',
        sourceMetadata: { source: 'custom' },
        features: []
      }
      const res3 = validateImportPayload(snakeVersionEnvelope)
      expect(res3.valid).toBe(false)
      expect(res3.errors.some((e) => e.includes('Unsupported project schema version') && e.includes('0.9.0'))).toBe(true)

      // 4. Project envelope candidate missing schemaVersion completely
      const missingVersionEnvelope = {
        sourceMetadata: { source: 'osm' },
        projectionOrigin: { lon: -71.11, lat: 42.41 },
        features: [
          {
            id: 'feat_test',
            role: 'road',
            sourceGeometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.41],
                [-71.1, 42.42]
              ]
            }
          }
        ]
      }
      const res4 = validateImportPayload(missingVersionEnvelope)
      expect(res4.valid).toBe(false)
      expect(res4.errors.some((e) => e.includes('Missing project schema version'))).toBe(true)
      // Must NOT fall back to raw GeoJSON interpretation
      expect(res4.source).not.toBe('overture')
    })

    it('rejects exported EditorGodotPayload rather than misinterpreting as raw GeoJSON or reopenable project', () => {
      const editorPayload = {
        type: 'FeatureCollection',
        generator: 'osm-to-godot-editor',
        editorPayloadVersion: '1.0.0',
        metadata: {
          sourceMetadata: { source: 'osm' }
        },
        features: [
          {
            type: 'Feature',
            id: 'surf_1',
            geometry: {
              type: 'Polygon',
              coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
            },
            properties: {
              role: 'road_surface'
            }
          }
        ]
      }
      const res = validateImportPayload(editorPayload)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('exported scene payload (EditorGodotPayload)'))).toBe(true)
      expect(res.errors.some((e) => e.includes('ProjectEnvelope JSON file'))).toBe(true)
    })
    it('emits actionable size-limit warnings for large feature counts and areas', () => {
      // Large feature count payload
      const largeFeatures = Array.from({ length: 10005 }, (_, i) => ({
        type: 'Feature',
        id: `f_${i}`,
        geometry: { type: 'Point', coordinates: [-71.1, 42.4] },
        properties: { amenity: 'bench' }
      }))
      const largePayload = {
        type: 'FeatureCollection',
        features: largeFeatures
      }
      const res = validateImportPayload(largePayload)
      expect(res.valid).toBe(true)
      expect(res.warnings.some((w) => w.includes('exceeds the recommended limit of 10000'))).toBe(true)
      expect(res.actionableAdvice?.some((a) => a.includes('Select a smaller bounding box'))).toBe(true)
    })

    it('provides actionable remediation advice for validation errors and size limits', () => {
      const advice1 = getActionableValidationAdvice('Selected area (15.0 km²) exceeds supported limit of 10 km².')
      expect(advice1).toContain('Reduce the bounding box selection to under 10 km²')

      const advice2 = getActionableValidationAdvice('Origin latitude 88.00° exceeds maximum supported latitude of ±85°.')
      expect(advice2).toContain('Choose an area between -85° and +85° latitude')

      const advice3 = getActionableValidationAdvice('Mixed-source payload detected (contains both OSM and Overture features).')
      expect(advice3).toContain('cross-source conflation is not supported')
    })
  })

  describe('Edit validation', () => {
    describe('validatePositiveWidth', () => {
      it('accepts finite positive widths within bounds', () => {
        expect(validatePositiveWidth(6.0).valid).toBe(true)
        expect(validatePositiveWidth(0.5, 'Width', { min: 0.5 }).valid).toBe(true)
        expect(validatePositiveWidth(30.0, 'Width', { max: 50 }).valid).toBe(true)
      })

      it('rejects non-finite, negative, zero, or out of range widths', () => {
        expect(validatePositiveWidth(0).valid).toBe(false)
        expect(validatePositiveWidth(-5).valid).toBe(false)
        expect(validatePositiveWidth(NaN).valid).toBe(false)
        expect(validatePositiveWidth(Infinity).valid).toBe(false)
        expect(validatePositiveWidth('6' as unknown as number).valid).toBe(false)
        expect(validatePositiveWidth(0.1, 'Width', { min: 0.5 }).valid).toBe(false)
        expect(validatePositiveWidth(120, 'Width', { max: 100 }).valid).toBe(false)
      })
    })

    describe('validateBuildingLevels', () => {
      it('accepts positive whole numbers', () => {
        expect(validateBuildingLevels(1).valid).toBe(true)
        expect(validateBuildingLevels(5).valid).toBe(true)
        expect(validateBuildingLevels(100).valid).toBe(true)
      })

      it('rejects non-integer, negative, zero, or excessive levels', () => {
        expect(validateBuildingLevels(0).valid).toBe(false)
        expect(validateBuildingLevels(-2).valid).toBe(false)
        expect(validateBuildingLevels(2.5).valid).toBe(false)
        expect(validateBuildingLevels(NaN).valid).toBe(false)
        expect(validateBuildingLevels(500).valid).toBe(false)
      })
    })

    describe('validateBuildingHeight', () => {
      it('accepts finite positive heights within plausible range', () => {
        expect(validateBuildingHeight(3.0).valid).toBe(true)
        expect(validateBuildingHeight(15.5).valid).toBe(true)
        expect(validateBuildingHeight(828).valid).toBe(true)
      })

      it('rejects non-positive or extreme heights', () => {
        expect(validateBuildingHeight(0).valid).toBe(false)
        expect(validateBuildingHeight(-10).valid).toBe(false)
        expect(validateBuildingHeight(0.1).valid).toBe(false) // < 0.5m
        expect(validateBuildingHeight(1500).valid).toBe(false) // > 1200m
        expect(validateBuildingHeight(Infinity).valid).toBe(false)
      })
    })

    describe('validateStripTotals', () => {
      it('accepts valid strip sets with positive widths', () => {
        const strips = [
          { id: 's1', widthMeters: 2.0 },
          { id: 's2', widthMeters: 6.0 },
          { id: 's3', widthMeters: 2.0 }
        ]
        expect(validateStripTotals(strips).valid).toBe(true)
      })

      it('rejects empty strip arrays or strips with non-positive widths', () => {
        expect(validateStripTotals([]).valid).toBe(false)
        expect(validateStripTotals([{ id: 's1', widthMeters: 0 }]).valid).toBe(false)
        expect(validateStripTotals([{ id: 's1', widthMeters: -3 }]).valid).toBe(false)
        expect(validateStripTotals([{ id: 's1', widthMeters: NaN }]).valid).toBe(false)
      })

      it('rejects strips whose total exceeds plausible maximum corridor width', () => {
        expect(validateStripTotals([{ id: 'huge', widthMeters: 250 }]).valid).toBe(false)
      })
    })

    describe('validateRoadLanes', () => {
      it('accepts positive integer lane counts and consistent directional split', () => {
        expect(validateRoadLanes(2).valid).toBe(true)
        expect(validateRoadLanes(4, { forwardLanes: 2, backwardLanes: 2 }).valid).toBe(true)
        expect(validateRoadLanes(3, { forwardLanes: 2, backwardLanes: 1 }).valid).toBe(true)
      })

      it('rejects mismatched directional lane sum when provided', () => {
        const res = validateRoadLanes(3, { forwardLanes: 2, backwardLanes: 2 })
        expect(res.valid).toBe(false)
        expect(res.error).toContain('Sum of directional lanes')
      })

      it('rejects non-integer, non-positive or extreme lane counts', () => {
        expect(validateRoadLanes(0).valid).toBe(false)
        expect(validateRoadLanes(-1).valid).toBe(false)
        expect(validateRoadLanes(1.5).valid).toBe(false)
        expect(validateRoadLanes(50).valid).toBe(false)
      })
    })

    describe('validateRoadSpeedLimit', () => {
      it('accepts null/undefined or positive finite speed limits', () => {
        expect(validateRoadSpeedLimit(null).valid).toBe(true)
        expect(validateRoadSpeedLimit(undefined).valid).toBe(true)
        expect(validateRoadSpeedLimit(50).valid).toBe(true)
        expect(validateRoadSpeedLimit(120).valid).toBe(true)
      })

      it('rejects negative, zero, or absurd speed limits', () => {
        expect(validateRoadSpeedLimit(0).valid).toBe(false)
        expect(validateRoadSpeedLimit(-30).valid).toBe(false)
        expect(validateRoadSpeedLimit(500).valid).toBe(false)
      })
    })

    describe('validateRoadProperties', () => {
      it('accepts valid supported property combinations', () => {
        expect(validateRoadProperties({ direction: 'forward', lanes: 2 }).valid).toBe(true)
        expect(validateRoadProperties({ surface: 'asphalt' }).valid).toBe(true)
        expect(validateRoadProperties({ highwayClass: 'primary' }).valid).toBe(true)
      })

      it('rejects empty strings or invalid directions', () => {
        expect(validateRoadProperties({ direction: 'sideways' as unknown as 'forward' }).valid).toBe(false)
        expect(validateRoadProperties({ surface: '   ' }).valid).toBe(false)
        expect(validateRoadProperties({ highwayClass: '' }).valid).toBe(false)
      })
    })
  })

  describe('validateEditorGodotPayload', () => {
    it('validates a correct versioned editor payload', () => {
      const payload = {
        type: 'FeatureCollection',
        generator: 'osm-to-godot-editor',
        editorPayloadVersion: '1.0.0',
        metadata: {
          generator: 'osm-to-godot-editor',
          version: '1.0.0',
          exportedAt: new Date().toISOString(),
          sourceMetadata: { source: 'osm' },
          projectionOrigin: { lon: -71.11, lat: 42.41 },
          exportInclusions: { road: true, building: true },
          featureCounts: { total: 1, roads: 1, buildings: 0, sidewalks: 0, bikeLanes: 0, junctions: 0 }
        },
        projectionOrigin: { lon: -71.11, lat: 42.41 },
        features: [
          {
            type: 'Feature',
            id: 'feat_1',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-71.11, 42.41],
                  [-71.10, 42.41],
                  [-71.10, 42.42],
                  [-71.11, 42.41]
                ]
              ]
            },
            properties: {
              id: 'feat_1',
              role: 'carriageway',
              kind: 'road',
              isPolygon: true,
              isFootprintAuthority: true
            }
          }
        ]
      }
      const res = validateEditorGodotPayload(payload)
      expect(res.valid).toBe(true)
      expect(res.version).toBe('1.0.0')
      expect(res.errors.length).toBe(0)
      expect(res.stats.totalFeatures).toBe(1)
      expect(res.stats.roles.carriageway).toBe(1)
    })

    it('rejects unsupported or missing version', () => {
      const missingVersion = {
        type: 'FeatureCollection',
        features: []
      }
      expect(validateEditorGodotPayload(missingVersion).valid).toBe(false)
      expect(validateEditorGodotPayload(missingVersion).errors[0]).toContain('Missing editor payload version')

      const wrongVersion = {
        type: 'FeatureCollection',
        editorPayloadVersion: '2.5.0',
        features: []
      }
      expect(validateEditorGodotPayload(wrongVersion).valid).toBe(false)
      expect(validateEditorGodotPayload(wrongVersion).errors[0]).toContain('Unsupported editor payload version: "2.5.0"')
    })

    it('rejects invalid feature geometry or missing id', () => {
      const invalid = {
        type: 'FeatureCollection',
        editorPayloadVersion: '1.0.0',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[0, 0]] },
            properties: { role: 'road' }
          }
        ]
      }
      const res = validateEditorGodotPayload(invalid)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('missing a valid string id'))).toBe(true)
      expect(res.errors.some((e) => e.includes('invalid geometry'))).toBe(true)
    })
  })
})
