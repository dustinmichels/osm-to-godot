import { describe, it, expect } from 'bun:test'
import {
  pointInPolygon,
  pointInGeometry,
  computeGeometryBBox,
  extractPoiName,
  extractPoiCategories,
  extractAddressInfo,
  enrichBuildingFootprints
} from './enrichment'
import type { RawGeoJSONFeature } from './types'

describe('duckdb spatial enrichment', () => {
  describe('pointInPolygon', () => {
    // 10x10 square from (0,0) to (10,10)
    const squareRing = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0]
    ]

    it('identifies point strictly inside polygon', () => {
      expect(pointInPolygon(5, 5, squareRing)).toBe(true)
      expect(pointInPolygon(1, 1, squareRing)).toBe(true)
      expect(pointInPolygon(9, 9, squareRing)).toBe(true)
    })

    it('identifies point strictly outside polygon', () => {
      expect(pointInPolygon(-1, 5, squareRing)).toBe(false)
      expect(pointInPolygon(15, 5, squareRing)).toBe(false)
      expect(pointInPolygon(5, -1, squareRing)).toBe(false)
      expect(pointInPolygon(5, 11, squareRing)).toBe(false)
    })

    it('returns false for degenerate ring (<3 points)', () => {
      expect(pointInPolygon(5, 5, [[0, 0], [10, 10]])).toBe(false)
    })
  })

  describe('pointInGeometry', () => {
    // Square (0,0)-(10,10) with hole (3,3)-(7,7)
    const polyWithHole = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0]
        ],
        [
          [3, 3],
          [7, 3],
          [7, 7],
          [3, 7],
          [3, 3]
        ]
      ]
    }

    it('returns true when point is inside exterior ring and outside interior hole', () => {
      expect(pointInGeometry(1, 1, polyWithHole)).toBe(true)
      expect(pointInGeometry(2, 5, polyWithHole)).toBe(true)
    })

    it('returns false when point is inside interior hole', () => {
      expect(pointInGeometry(5, 5, polyWithHole)).toBe(false)
      expect(pointInGeometry(4, 4, polyWithHole)).toBe(false)
    })

    it('returns false when point is outside exterior ring', () => {
      expect(pointInGeometry(12, 12, polyWithHole)).toBe(false)
    })

    it('handles MultiPolygon correctly', () => {
      const multiPoly = {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [5, 0],
              [5, 5],
              [0, 5],
              [0, 0]
            ]
          ],
          [
            [
              [20, 20],
              [25, 20],
              [25, 25],
              [20, 25],
              [20, 20]
            ]
          ]
        ]
      }

      expect(pointInGeometry(2, 2, multiPoly)).toBe(true)
      expect(pointInGeometry(22, 22, multiPoly)).toBe(true)
      expect(pointInGeometry(10, 10, multiPoly)).toBe(false)
    })

    it('returns false for null or unsupported geometry', () => {
      expect(pointInGeometry(1, 1, null)).toBe(false)
      expect(pointInGeometry(1, 1, { type: 'Point', coordinates: [1, 1] })).toBe(false)
    })
  })

  describe('computeGeometryBBox', () => {
    it('computes correct bounding box for Polygon', () => {
      const geom = {
        type: 'Polygon',
        coordinates: [
          [
            [-71.12, 42.4],
            [-71.10, 42.4],
            [-71.10, 42.42],
            [-71.12, 42.42],
            [-71.12, 42.4]
          ]
        ]
      }
      const bbox = computeGeometryBBox(geom)
      expect(bbox).not.toBeNull()
      expect(bbox!.minX).toBeCloseTo(-71.12)
      expect(bbox!.minY).toBeCloseTo(42.4)
      expect(bbox!.maxX).toBeCloseTo(-71.10)
      expect(bbox!.maxY).toBeCloseTo(42.42)
    })

    it('returns null for empty or invalid geometry', () => {
      expect(computeGeometryBBox(null)).toBeNull()
      expect(computeGeometryBBox({ type: 'Polygon', coordinates: [] })).toBeNull()
    })
  })

  describe('extractPoiName', () => {
    it('extracts primary name first', () => {
      const props = {
        names: { primary: 'Primary Cafe', common: 'Common Cafe' },
        name: 'Fallback Name'
      }
      expect(extractPoiName(props)).toBe('Primary Cafe')
    })

    it('falls back to common name when primary is absent', () => {
      const props = {
        names: { common: 'Common Cafe' },
        name: 'Fallback Name'
      }
      expect(extractPoiName(props)).toBe('Common Cafe')
    })

    it('falls back to name tag then name:en', () => {
      expect(extractPoiName({ name: 'Medford Hall' })).toBe('Medford Hall')
      expect(extractPoiName({ 'name:en': 'English Name' })).toBe('English Name')
    })

    it('extracts brand name if names struct is absent', () => {
      expect(extractPoiName({ brand: { names: { primary: 'Starbucks' } } })).toBe('Starbucks')
      expect(extractPoiName({ brand: 'Dunkin' })).toBe('Dunkin')
    })

    it('ignores null, empty, or <null> string names', () => {
      expect(extractPoiName({ names: { primary: '<null>' }, name: 'Real Name' })).toBe('Real Name')
      expect(extractPoiName({})).toBe('')
    })
  })

  describe('extractPoiCategories', () => {
    it('extracts primary and alternate categories from struct', () => {
      const props = {
        categories: {
          primary: 'restaurant',
          alternate: ['bakery', 'cafe']
        }
      }
      expect(extractPoiCategories(props)).toEqual(['restaurant', 'bakery', 'cafe'])
    })

    it('extracts categories from array or string', () => {
      expect(extractPoiCategories({ categories: ['doctor', 'dentist'] })).toEqual(['doctor', 'dentist'])
      expect(extractPoiCategories({ category: 'pharmacy' })).toEqual(['pharmacy'])
    })

    it('falls back to class/subclass if categories is absent', () => {
      expect(extractPoiCategories({ class: 'hospital', subclass: 'clinic' })).toEqual(['hospital', 'clinic'])
    })
  })

  describe('extractAddressInfo', () => {
    it('formats number, title-cased street, unit, and locality', () => {
      const props = {
        number: '101',
        street: 'MAIN STREET',
        unit: 'Suite 200',
        locality: 'Medford'
      }
      const addr = extractAddressInfo(props)
      expect(addr.number).toBe('101')
      expect(addr.street).toBe('Main Street')
      expect(addr.full).toBe('101 Main Street Suite 200')
      expect(addr.locality).toBe('Medford')
    })

    it('handles street only without number', () => {
      const props = { street: 'BOSTON AVENUE' }
      const addr = extractAddressInfo(props)
      expect(addr.full).toBe('Boston Avenue')
    })
  })

  describe('enrichBuildingFootprints', () => {
    const buildingPoly: RawGeoJSONFeature = {
      type: 'Feature',
      id: 'bldg_1',
      overture_type: 'building',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-71.111, 42.415],
            [-71.110, 42.415],
            [-71.110, 42.416],
            [-71.111, 42.416],
            [-71.111, 42.415]
          ]
        ]
      },
      properties: {
        height: 12.0
      }
    }

    const placeInside: RawGeoJSONFeature = {
      type: 'Feature',
      id: 'place_1',
      overture_type: 'place',
      geometry: {
        type: 'Point',
        coordinates: [-71.1105, 42.4155]
      },
      properties: {
        names: { primary: 'Medford Medical Center' },
        categories: { primary: 'clinic', alternate: ['medical_office'] }
      }
    }

    const addressInside: RawGeoJSONFeature = {
      type: 'Feature',
      id: 'addr_1',
      overture_type: 'address',
      geometry: {
        type: 'Point',
        coordinates: [-71.1106, 42.4156]
      },
      properties: {
        number: '101',
        street: 'MAIN STREET',
        locality: 'Medford'
      }
    }

    const placeOutside: RawGeoJSONFeature = {
      type: 'Feature',
      id: 'place_outside',
      overture_type: 'place',
      geometry: {
        type: 'Point',
        coordinates: [-71.120, 42.420]
      },
      properties: {
        names: { primary: 'Distant Diner' }
      }
    }

    it('enriches building footprint with POI and address data', () => {
      const features = [buildingPoly, placeInside, addressInside, placeOutside]
      const { features: enriched, labeledBuildingsCount } = enrichBuildingFootprints(features)

      expect(labeledBuildingsCount).toBe(1)
      const bldg = enriched.find((f) => f.id === 'bldg_1')!
      expect(bldg).toBeDefined()

      // Primary name should be adopted from the POI
      expect(bldg.properties.name).toBe('Medford Medical Center')
      const namesObj = bldg.properties.names as Record<string, unknown> | undefined
      expect(namesObj?.primary).toBe('Medford Medical Center')

      // POI list and categories
      expect(bldg.properties.poi_names).toEqual(['Medford Medical Center'])
      expect(bldg.properties.poi_categories).toEqual(['clinic', 'medical_office'])
      const categoriesObj = bldg.properties.categories as Record<string, unknown> | undefined
      expect(categoriesObj?.primary).toBe('clinic')

      // Matched address list and addresses struct
      expect(Array.isArray(bldg.properties.matched_addresses)).toBe(true)
      const matchedAddrs = bldg.properties.matched_addresses as Array<Record<string, unknown>>
      const matchedAddr = matchedAddrs[0]
      expect(matchedAddr.number).toBe('101')
      expect(matchedAddr.street).toBe('Main Street')
      expect(matchedAddr.full).toBe('101 Main Street')

      expect(Array.isArray(bldg.properties.addresses)).toBe(true)
      const addressesList = bldg.properties.addresses as Array<Record<string, unknown>>
      expect(addressesList[0]).toEqual({
        freeform: '101 Main Street',
        locality: 'Medford'
      })
    })

    it('falls back to address when no POI is inside the building footprint', () => {
      const bldgWithoutName: RawGeoJSONFeature = {
        type: 'Feature',
        id: 'bldg_2',
        overture_type: 'building',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.111, 42.415],
              [-71.110, 42.415],
              [-71.110, 42.416],
              [-71.111, 42.416],
              [-71.111, 42.415]
            ]
          ]
        },
        properties: {}
      }

      const { features: enriched, labeledBuildingsCount } = enrichBuildingFootprints([
        bldgWithoutName,
        addressInside
      ])

      expect(labeledBuildingsCount).toBe(1)
      const bldg = enriched.find((f) => f.id === 'bldg_2')!
      expect(bldg.properties.name).toBe('101 Main Street')
      const namesObj = bldg.properties.names as Record<string, unknown> | undefined
      expect(namesObj?.primary).toBe('101 Main Street')
    })

    it('preserves existing building name and does not overwrite it', () => {
      const bldgWithExistingName: RawGeoJSONFeature = {
        type: 'Feature',
        id: 'bldg_3',
        overture_type: 'building',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-71.111, 42.415],
              [-71.110, 42.415],
              [-71.110, 42.416],
              [-71.111, 42.416],
              [-71.111, 42.415]
            ]
          ]
        },
        properties: {
          name: 'Historic Courthouse',
          names: { primary: 'Historic Courthouse' }
        }
      }

      const { features: enriched, labeledBuildingsCount } = enrichBuildingFootprints([
        bldgWithExistingName,
        placeInside
      ])

      expect(labeledBuildingsCount).toBe(0)
      const bldg = enriched.find((f) => f.id === 'bldg_3')!
      expect(bldg.properties.name).toBe('Historic Courthouse')
      const namesObj = bldg.properties.names as Record<string, unknown> | undefined
      expect(namesObj?.primary).toBe('Historic Courthouse')
      // Still attaches POIs
      expect(bldg.properties.poi_names).toEqual(['Medford Medical Center'])
    })
  })
})
