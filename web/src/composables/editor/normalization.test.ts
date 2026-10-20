import complexBuildingsFixture from '../../../../tests/fixtures/complex_buildings.json'
import { describe, it, expect } from 'bun:test'
import {
  normalizeOverturePayload,
  normalizeOsmPayload,
  determineOvertureSemanticKind,
  determineOsmSemanticKind,
  isOsmWayArea,
  parseOsmDimension,
  recalculateRoadStrips
} from './normalization'
import { validateImportPayload } from './validation'
describe('normalization', () => {
  it('normalizes Overture GeoJSON FeatureCollection into ProjectEnvelope', () => {
    const rawOverture = {
      type: 'FeatureCollection',
      features: [
        {
          id: 'bldg_1',
          overture_type: 'building',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.11, 42.41],
                [-71.10, 42.41],
                [-71.10, 42.42],
                [-71.11, 42.42],
                [-71.11, 42.41]
              ]
            ]
          },
          properties: {
            height: 12.5,
            num_floors: 3
          }
        },
        {
          id: 'seg_1',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.41],
              [-71.10, 42.41]
            ]
          },
          properties: {
            width: 8
          }
        }
      ]
    }

    const project = normalizeOverturePayload(rawOverture, {
      source: 'overture',
      bbox: { west: -71.12, south: 42.4, east: -71.09, north: 42.43 }
    })

    expect(project.schemaVersion).toBe('1.0.0')
    expect(project.sourceMetadata.source).toBe('overture')
    expect(project.features.length).toBe(2)

    const building = project.features.find((f) => f.id === 'bldg_1')!
    expect(building.role).toBe('building')
    expect(building.buildingProfile?.heightMeters?.value).toBe(12.5)
    expect(building.buildingProfile?.levels?.value).toBe(3)

    const road = project.features.find((f) => f.id === 'seg_1')!
    expect(road.role).toBe('road')
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(8)
    expect(road.roadProfile?.carriagewayWidthMeters.provenance).toBe('source')
    expect(road.inferred.width).toBe(false)
  })

  it('maps Overture building and transportation properties without mutating to OSM tags', () => {
    const overtureData = {
      type: 'FeatureCollection',
      features: [
        {
          id: 'bldg_ov',
          overture_type: 'building',
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
            subtype: 'commercial',
            class: 'office',
            height: 18.2,
            num_floors: 5,
            names: {
              primary: 'Civic Tower'
            },
            sources: [
              { dataset: 'Microsoft ML Buildings', confidence: 0.98 }
            ]
          }
        },
        {
          id: 'road_ov',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.41],
              [-71.10, 42.41]
            ]
          },
          properties: {
            subtype: 'road',
            class: 'secondary',
            names: {
              primary: 'Main Street'
            },
            width_rules: [{ value: 14.0 }],
            lanes_rules: [{ value: 3 }],
            road_surface: [{ value: 'asphalt' }],
            road_flags: [{ values: ['is_bridge'] }],
            level_rules: [{ value: 1 }],
            access_restrictions: [
              { access_type: 'denied', when: { heading: 'backward' } }
            ]
          }
        }
      ]
    }

    const project = normalizeOverturePayload(overtureData)
    expect(project.features.length).toBe(2)

    const bldg = project.features.find((f) => f.id === 'bldg_ov')!
    expect(bldg.role).toBe('building')
    expect(bldg.sourceReference?.type).toBe('overture_building')
    expect(bldg.buildingProfile?.heightMeters?.value).toBe(18.2)
    expect(bldg.buildingProfile?.heightMeters?.provenance).toBe('source')
    expect(bldg.buildingProfile?.levels?.value).toBe(5)
    expect(bldg.buildingProfile?.levels?.provenance).toBe('source')
    expect(bldg.buildingProfile?.surface?.value).toBe('office')
    // Crucial: Properties are native Overture schema, not rewritten into fake OSM tags like building:levels or highway
    expect(bldg.properties.height).toBe(18.2)
    expect(bldg.properties['building:levels']).toBeUndefined()

    const road = project.features.find((f) => f.id === 'road_ov')!
    expect(road.role).toBe('road')
    expect(road.sourceReference?.type).toBe('overture_segment')
    expect(road.roadProfile?.name).toBe('Main Street')
    expect(road.roadProfile?.highwayClass).toBe('secondary')
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(14.0)
    expect(road.roadProfile?.carriagewayWidthMeters.provenance).toBe('source')
    expect(road.roadProfile?.lanes?.value).toBe(3)
    expect(road.roadProfile?.lanes?.provenance).toBe('source')
    expect(road.roadProfile?.surface?.value).toBe('asphalt')
    expect(road.roadProfile?.bridge).toBe(true)
    expect(road.roadProfile?.layer).toBe(1)
    expect(road.roadProfile?.oneWay).toBe(true)
    expect(road.roadProfile?.direction).toBe('forward')
    // Crucial: Properties retain original Overture shape, not rewritten as tags
    expect(road.properties.highway).toBeUndefined()
    expect(road.properties.class).toBe('secondary')
  })

  it('preserves Overture identifiers, source attribution, release information, connectors, and segment-relative attributes', () => {
    const overtureData = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        release: '2026-09-17.0'
      },
      features: [
        {
          id: 'segment_100',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.41],
              [-71.10, 42.41]
            ]
          },
          properties: {
            class: 'primary',
            connectors: [
              { connector_id: 'conn_a', at: 0.0 },
              { connector_id: 'conn_b', at: 1.0 }
            ],
            sources: [
              {
                property: '',
                dataset: 'OpenStreetMap',
                record_id: 'w12345',
                update_time: '2026-01-01T00:00:00Z'
              }
            ],
            between: [0.0, 0.5],
            parent_id: 'parent_seg_1'
          }
        }
      ]
    }

    const project = normalizeOverturePayload(overtureData)
    expect(project.sourceMetadata.attribution).toBe('Overture Maps Foundation')
    expect(project.sourceMetadata.release).toBe('2026-09-17.0')
    expect(project.sourceMetadata.connectorConnectivity?.conn_a).toEqual(['segment_100'])
    expect(project.sourceMetadata.connectorConnectivity?.conn_b).toEqual(['segment_100'])

    const feature = project.features[0]
    expect(feature.id).toBe('segment_100')
    expect(feature.sourceReference?.overtureId).toBe('segment_100')
    expect(feature.sourceReference?.release).toBe('2026-09-17.0')
    expect(feature.connectors).toEqual([
      { connectorId: 'conn_a', at: 0.0 },
      { connectorId: 'conn_b', at: 1.0 }
    ])
    expect(feature.overtureSources?.length).toBe(1)
    expect(feature.overtureSources?.[0].dataset).toBe('OpenStreetMap')
    expect(feature.segmentRelative?.between).toEqual([0.0, 0.5])
    expect(feature.segmentRelative?.parentSourceId).toBe('parent_seg_1')
  })

  it('resolves attributes applying to only part of a transportation segment into subsegments with parent-source references', () => {
    const segmentedData = {
      type: 'FeatureCollection',
      features: [
        {
          id: 'seg_multi_rule',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-71.10, 42.40],
              [-71.10, 42.50]
            ]
          },
          properties: {
            class: 'residential',
            subclass_rules: [
              {
                value: 'sidewalk',
                between: [0.0, 0.4]
              },
              {
                value: 'crosswalk',
                between: [0.4, 1.0]
              }
            ],
            width_rules: [
              {
                value: 4.0,
                between: [0.0, 0.4]
              },
              {
                value: 8.0,
                between: [0.4, 1.0]
              }
            ]
          }
        }
      ]
    }

    const project = normalizeOverturePayload(segmentedData)
    // Segment should be split into 2 subsegments
    expect(project.features.length).toBe(2)

    const sub1 = project.features[0]
    const sub2 = project.features[1]

    expect(sub1.id).toBe('seg_multi_rule_sub_1')
    expect(sub1.parentFeatureId).toBe('seg_multi_rule')
    expect(sub1.sourceId).toBe('seg_multi_rule')
    expect(sub1.sourceReference?.id).toBe('seg_multi_rule')
    expect(sub1.sourceReference?.overtureId).toBe('seg_multi_rule')
    expect(sub1.segmentRelative?.parentSourceId).toBe('seg_multi_rule')
    expect(sub1.segmentRelative?.between).toEqual([0.0, 0.4])
    expect(sub1.roadProfile?.carriagewayWidthMeters.value).toBe(4.0)
    expect((sub1.sourceGeometry as GeoJSON.LineString).coordinates[0]).toEqual([-71.10, 42.40])

    expect(sub2.id).toBe('seg_multi_rule_sub_2')
    expect(sub2.sourceId).toBe('seg_multi_rule')
    expect(sub2.sourceReference?.id).toBe('seg_multi_rule')
    expect(sub2.sourceReference?.overtureId).toBe('seg_multi_rule')
    expect(sub2.segmentRelative?.parentSourceId).toBe('seg_multi_rule')
    expect(sub2.segmentRelative?.between).toEqual([0.4, 1.0])
    expect(sub2.properties.subclass).toBe('crosswalk')
    expect(sub2.roadProfile?.carriagewayWidthMeters.value).toBe(8.0)
    expect((sub2.sourceGeometry as GeoJSON.LineString).coordinates[1]).toEqual([-71.10, 42.50])
  })

  it('surfaces partial download failures on ProjectEnvelope while retaining usable features', () => {
    const partialOverture = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        counts: { segment: 1, building: 0 },
        failed_themes: ['building'],
        errors: { building: 'HTTP 504 Gateway Timeout' }
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_success',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [[-71.10, 42.40], [-71.10, 42.50]]
          },
          properties: {
            class: 'primary'
          }
        }
      ]
    }

    const project = normalizeOverturePayload(partialOverture)
    expect(project.features.length).toBe(1)
    expect(project.features[0].id).toBe('seg_success')
    expect(project.sourceMetadata.failedThemes).toEqual(['building'])
    expect(project.warnings).toBeDefined()
    expect(project.warnings?.some((w) => w.includes('Building download failed: HTTP 504 Gateway Timeout'))).toBe(true)
    expect(project.warnings?.some((w) => w.includes('Partial download failure'))).toBe(true)
  })

  it('distinguishes legitimate "no buildings here" without recording a failure', () => {
    const emptyBldgOverture = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        counts: { segment: 1, building: 0 },
        theme_status: {
          segment: { status: 'success', count: 1 },
          building: { status: 'empty', count: 0 }
        },
        failed_themes: []
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_rural',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [[-71.10, 42.40], [-71.10, 42.50]]
          },
          properties: {
            class: 'unclassified'
          }
        }
      ]
    }

    const project = normalizeOverturePayload(emptyBldgOverture)
    expect(project.features.length).toBe(1)
    expect(project.sourceMetadata.failedThemes).toEqual([])
    expect(project.sourceMetadata.emptyThemes).toEqual(['building'])
    // Contains info notice but not a failure warning
    expect(project.warnings?.some((w) => w.includes('Building download failed'))).toBe(false)
    expect(project.warnings?.some((w) => w.includes('Partial download failure'))).toBe(false)
    expect(project.warnings?.some((w) => w.includes('No buildings found in the selected area'))).toBe(true)
  })

  it('surfaces missing themes when dataset does not include them', () => {
    const roadsOnlyOverture = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        counts: { segment: 1 }
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_only',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [[-71.10, 42.40], [-71.10, 42.50]]
          }
        }
      ]
    }

    const project = normalizeOverturePayload(roadsOnlyOverture)
    expect(project.sourceMetadata.missingThemes).toContain('building')
    expect(project.warnings?.some((w) => w.includes('Buildings theme was not included'))).toBe(true)
  })

  it('normalizes OSM Overpass payload into ProjectEnvelope', () => {
    const rawOsm = {
      elements: [
        {
          type: 'way',
          id: 101,
          tags: {
            building: 'yes',
            height: '15'
          },
          geometry: [
            { lon: -71.11, lat: 42.41 },
            { lon: -71.10, lat: 42.41 },
            { lon: -71.10, lat: 42.42 },
            { lon: -71.11, lat: 42.41 }
          ]
        },
        {
          type: 'way',
          id: 202,
          tags: {
            highway: 'residential',
            name: 'Main Street'
          },
          geometry: [
            { lon: -71.11, lat: 42.41 },
            { lon: -71.10, lat: 42.41 }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm, {
      source: 'osm'
    })

    expect(project.schemaVersion).toBe('1.0.0')
    expect(project.sourceMetadata.source).toBe('osm')
    expect(project.features.length).toBe(2)

    const building = project.features.find((f) => f.id === 'osm_w101')!
    expect(building.role).toBe('building')
    expect(building.buildingProfile?.heightMeters?.value).toBe(15)

    const road = project.features.find((f) => f.id === 'osm_w202')!
    expect(road.role).toBe('road')
    expect(road.roadProfile?.carriagewayWidthMeters.value).toBe(6) // Default inferred
    expect(road.inferred.width).toBe(true)
  })

  it('accepts application downloaded Overpass JSON with metadata and fallback acquisition output', () => {
    const downloadedPayload = {
      metadata: {
        version: '1.0',
        generator: 'osm-to-godot web exporter',
        source: 'osm_0_6',
        bbox: { west: -71.112, south: 42.414, east: -71.108, north: 42.416 },
        centroid: { lon: -71.11, lat: 42.415 }
      },
      elements: [
        {
          type: 'way',
          id: 501,
          tags: { highway: 'primary', width: '12' },
          geometry: [
            { lon: -71.111, lat: 42.414 },
            { lon: -71.109, lat: 42.416 }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(downloadedPayload)
    expect(project.sourceMetadata.source).toBe('osm')
    expect(project.sourceMetadata.acquisitionSource).toBe('osm_0_6')
    expect(project.sourceMetadata.bbox).toEqual([-71.112, 42.414, -71.108, 42.416])
    expect(project.projectionOrigin.lon).toBe(-71.11)
    expect(project.projectionOrigin.lat).toBe(42.415)
    expect(project.features.length).toBe(1)
    expect(project.features[0]?.role).toBe('road')
  })

  it('accepts node-referenced ways where geometry is resolved from elements', () => {
    const overpassWithoutGeom = {
      elements: [
        { type: 'node', id: 1, lat: 42.414, lon: -71.111 },
        { type: 'node', id: 2, lat: 42.415, lon: -71.110 },
        {
          type: 'way',
          id: 999,
          tags: { highway: 'residential' },
          nodes: [1, 2]
        }
      ]
    }

    const project = normalizeOsmPayload(overpassWithoutGeom)
    expect(project.features.length).toBe(1)
    expect(project.features[0]?.id).toBe('osm_w999')
    expect(project.features[0]?.sourceGeometry.type).toBe('LineString')
    const lineGeom = project.features[0]?.sourceGeometry as GeoJSON.LineString
    expect(lineGeom.coordinates).toEqual([
      [-71.111, 42.414],
      [-71.11, 42.415]
    ])
  })

  it('accepts stringified JSON and raw fallback XML', () => {
    const jsonString = JSON.stringify({
      elements: [
        {
          type: 'way',
          id: 777,
          tags: { building: 'yes' },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 0 },
            { lon: 1, lat: 1 },
            { lon: 0, lat: 0 }
          ]
        }
      ]
    })
    const projectFromJson = normalizeOsmPayload(jsonString)
    expect(projectFromJson.features.length).toBe(1)
    expect(projectFromJson.features[0]?.role).toBe('building')

    const osmXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="10" lat="42.0" lon="-71.0"/>
  <node id="11" lat="42.1" lon="-71.1"/>
  <way id="20">
    <nd ref="10"/>
    <nd ref="11"/>
    <tag k="highway" v="secondary"/>
  </way>
</osm>`
    const projectFromXml = normalizeOsmPayload(osmXml)
    expect(projectFromXml.features.length).toBe(1)
    expect(projectFromXml.features[0]?.id).toBe('osm_w20')
    expect(projectFromXml.features[0]?.role).toBe('road')
  })
  it('converts ways based on source semantics, not merely closed coordinates', () => {
    // 1. Closed roundabout highway -> LineString (not Polygon)
    expect(isOsmWayArea({ highway: 'residential', junction: 'roundabout' })).toBe(false)
    expect(isOsmWayArea({ barrier: 'fence' })).toBe(false)
    expect(isOsmWayArea({ building: 'commercial' })).toBe(true)
    expect(isOsmWayArea({ building: 'no', highway: 'secondary' })).toBe(false)
    expect(isOsmWayArea({ highway: 'pedestrian', area: 'yes' })).toBe(true)

    const closedRoundabout = {
      elements: [
        {
          type: 'way',
          id: 301,
          tags: { highway: 'primary', junction: 'roundabout' },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 0 },
            { lon: 1, lat: 1 },
            { lon: 0, lat: 1 },
            { lon: 0, lat: 0 } // Closed coordinate ring
          ]
        },
        {
          type: 'way',
          id: 302,
          tags: { highway: 'pedestrian', area: 'yes' },
          geometry: [
            { lon: 10, lat: 10 },
            { lon: 11, lat: 10 },
            { lon: 11, lat: 11 },
            { lon: 10, lat: 11 },
            { lon: 10, lat: 10 }
          ]
        },
        {
          type: 'way',
          id: 303,
          tags: { building: 'house' },
          geometry: [
            { lon: 20, lat: 20 },
            { lon: 21, lat: 20 },
            { lon: 21, lat: 21 },
            { lon: 20, lat: 21 } // Open coordinates
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(closedRoundabout)
    expect(project.features.length).toBe(3)

    const roundabout = project.features.find((f) => f.id === 'osm_w301')!
    expect(roundabout.role).toBe('road')
    expect(roundabout.sourceGeometry.type).toBe('LineString')

    const pedestrianArea = project.features.find((f) => f.id === 'osm_w302')!
    expect(pedestrianArea.role).toBe('road')
    expect(pedestrianArea.sourceGeometry.type).toBe('Polygon')

    const building = project.features.find((f) => f.id === 'osm_w303')!
    expect(building.role).toBe('building')
    expect(building.sourceGeometry.type).toBe('Polygon')
    const poly = building.sourceGeometry as GeoJSON.Polygon
    expect(poly.coordinates[0]?.length).toBe(5) // Closed ring
  })
  it('assembles multipolygon building relations with holes and multiple outer rings and avoids duplicating member ways', () => {
    const rawOsm = {
      elements: [
        // Outer ring segment 1
        {
          type: 'way',
          id: 10,
          tags: { building: 'yes' }, // tagged as building, should NOT be duplicated as standalone
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 10, lat: 0 },
            { lon: 10, lat: 10 }
          ]
        },
        // Outer ring segment 2 (reversed order)
        {
          type: 'way',
          id: 11,
          tags: { building: 'yes' },
          geometry: [
            { lon: 0, lat: 0 },
            { lon: 0, lat: 10 },
            { lon: 10, lat: 10 }
          ]
        },
        // Inner hole ring
        {
          type: 'way',
          id: 12,
          geometry: [
            { lon: 2, lat: 2 },
            { lon: 8, lat: 2 },
            { lon: 8, lat: 8 },
            { lon: 2, lat: 8 },
            { lon: 2, lat: 2 }
          ]
        },
        // Standalone independent building (should remain present)
        {
          type: 'way',
          id: 99,
          tags: { building: 'yes' },
          geometry: [
            { lon: 50, lat: 50 },
            { lon: 55, lat: 50 },
            { lon: 55, lat: 55 },
            { lon: 50, lat: 50 }
          ]
        },
        // Multipolygon relation
        {
          type: 'relation',
          id: 500,
          tags: {
            type: 'multipolygon',
            building: 'hospital',
            height: '24',
            'building:levels': '5'
          },
          members: [
            { type: 'way', ref: 10, role: 'outer' },
            { type: 'way', ref: 11, role: 'outer' },
            { type: 'way', ref: 12, role: 'inner' }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)

    // Expect exactly 2 features: the relation building osm_r500 and standalone building osm_w99
    // Member ways osm_w10, osm_w11, osm_w12 must NOT be duplicated as standalone features!
    expect(project.features.length).toBe(2)

    const relBuilding = project.features.find((f) => f.id === 'osm_r500')!
    expect(relBuilding).toBeDefined()
    expect(relBuilding.role).toBe('building')
    expect(relBuilding.sourceGeometry.type).toBe('Polygon')
    const polyGeom = relBuilding.sourceGeometry as GeoJSON.Polygon
    expect(polyGeom.coordinates.length).toBe(2) // Outer ring + 1 inner ring
    expect(polyGeom.coordinates[0]?.length).toBe(5) // Stitched outer ring
    expect(polyGeom.coordinates[1]?.length).toBe(5) // Inner hole ring
    expect(relBuilding.buildingProfile?.heightMeters?.value).toBe(24)
    expect(relBuilding.buildingProfile?.levels?.value).toBe(5)

    const standalone = project.features.find((f) => f.id === 'osm_w99')!
    expect(standalone).toBeDefined()
    expect(standalone.role).toBe('building')

    // Verify member ways are NOT duplicated
    expect(project.features.some((f) => f.id === 'osm_w10')).toBe(false)
    expect(project.features.some((f) => f.id === 'osm_w11')).toBe(false)
    expect(project.features.some((f) => f.id === 'osm_w12')).toBe(false)
  })

  it('assembles multipolygon with multiple outer rings as MultiPolygon', () => {
    const rawOsm = {
      elements: [
        {
          type: 'relation',
          id: 600,
          tags: {
            type: 'multipolygon',
            building: 'university'
          },
          members: [
            {
              type: 'way',
              ref: 601,
              role: 'outer',
              geometry: [
                { lon: 0, lat: 0 },
                { lon: 2, lat: 0 },
                { lon: 2, lat: 2 },
                { lon: 0, lat: 0 }
              ]
            },
            {
              type: 'way',
              ref: 602,
              role: 'outer',
              geometry: [
                { lon: 10, lat: 10 },
                { lon: 12, lat: 10 },
                { lon: 12, lat: 12 },
                { lon: 10, lat: 10 }
              ]
            }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)
    expect(project.features.length).toBe(1)
    const rel = project.features[0]!
    expect(rel.id).toBe('osm_r600')
    expect(rel.sourceGeometry.type).toBe('MultiPolygon')
    const multiGeom = rel.sourceGeometry as GeoJSON.MultiPolygon
    expect(multiGeom.coordinates.length).toBe(2) // Two outer polygons
  })
  it('preserves original node/way/relation identifiers, tags, and connectivity', () => {
    const rawOsm = {
      elements: [
        { type: 'node', id: 1, lat: 42.0, lon: -71.0, tags: { barrier: 'bollard' } },
        { type: 'node', id: 2, lat: 42.001, lon: -71.001 },
        { type: 'node', id: 3, lat: 42.002, lon: -71.002 },
        {
          type: 'way',
          id: 101,
          nodes: [1, 2],
          tags: { highway: 'primary', name: 'First Ave', surface: 'asphalt' }
        },
        {
          type: 'way',
          id: 102,
          nodes: [2, 3],
          tags: { highway: 'secondary', name: 'Second Ave' }
        },
        {
          type: 'relation',
          id: 501,
          tags: { type: 'multipolygon', building: 'commercial', name: 'Office Block' },
          members: [
            {
              type: 'way',
              ref: 999,
              role: 'outer',
              geometry: [
                { lon: 0, lat: 0 },
                { lon: 1, lat: 0 },
                { lon: 1, lat: 1 },
                { lon: 0, lat: 1 },
                { lon: 0, lat: 0 }
              ]
            }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)
    expect(project.features.length).toBe(3)

    // Feature IDs and sourceReferences
    const way1 = project.features.find((f) => f.id === 'osm_w101')!
    expect(way1).toBeDefined()
    expect(way1.sourceId).toBe('101')
    expect(way1.sourceReference?.type).toBe('way')
    expect(way1.sourceReference?.id).toBe(101)
    expect(way1.sourceReference?.nodes).toEqual([1, 2])
    expect(way1.sourceReference?.tags?.highway).toBe('primary')
    expect(way1.sourceReference?.tags?.name).toBe('First Ave')
    expect(way1.properties.name).toBe('First Ave')
    expect(way1.nodes).toEqual([1, 2])

    const way2 = project.features.find((f) => f.id === 'osm_w102')!
    expect(way2).toBeDefined()
    expect(way2.sourceId).toBe('102')
    expect(way2.nodes).toEqual([2, 3])

    const rel = project.features.find((f) => f.id === 'osm_r501')!
    expect(rel).toBeDefined()
    expect(rel.sourceId).toBe('501')
    expect(rel.sourceReference?.type).toBe('relation')
    expect(rel.sourceReference?.id).toBe(501)
    expect(rel.sourceReference?.tags?.building).toBe('commercial')
    expect(rel.sourceReference?.members?.length).toBe(1)
    expect(rel.properties.name).toBe('Office Block')

    // Node connectivity map
    const nodeConn = project.sourceMetadata.nodeConnectivity as Record<number, string[]>
    expect(nodeConn).toBeDefined()
    // Node 2 is shared between osm_w101 and osm_w102
    expect(nodeConn[2]).toContain('osm_w101')
    expect(nodeConn[2]).toContain('osm_w102')
    expect(nodeConn[1]).toEqual(['osm_w101'])
    expect(nodeConn[3]).toEqual(['osm_w102'])

    // Raw nodes dictionary
    const rawNodes = project.sourceMetadata.nodes as Record<number, { lat: number; lon: number; tags?: Record<string, string> }>
    expect(rawNodes[1]?.tags?.barrier).toBe('bollard')
  })

  it('normalizes road class, name, width, lane count, direction, surface, sidewalks, cycle facilities, bridge/tunnel status, and vertical layer', () => {
    const rawOsm = {
      elements: [
        {
          type: 'way',
          id: 301,
          tags: {
            highway: 'primary',
            name: 'Grand Boulevard',
            width: '18 m',
            lanes: '4',
            oneway: 'yes',
            surface: 'asphalt',
            'sidewalk:both': 'yes',
            'cycleway:right': 'lane',
            bridge: 'yes',
            layer: '2'
          },
          geometry: [
            { lon: -71.1, lat: 42.4 },
            { lon: -71.1, lat: 42.41 }
          ]
        },
        {
          type: 'way',
          id: 302,
          tags: {
            highway: 'residential',
            name: 'Oak Street',
            tunnel: 'yes'
          },
          geometry: [
            { lon: -71.11, lat: 42.4 },
            { lon: -71.11, lat: 42.41 }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)
    expect(project.features.length).toBe(2)

    const f1 = project.features.find((f) => f.id === 'osm_w301')!
    expect(f1).toBeDefined()
    const p1 = f1.roadProfile!
    expect(p1.name).toBe('Grand Boulevard')
    expect(p1.highwayClass).toBe('primary')
    expect(p1.carriagewayWidthMeters.value).toBe(16.5) // 18m explicit roadway minus 1.5m on-road bike lane
    expect(p1.roadwayWidthMeters?.value).toBe(18)
    expect(p1.carriagewayWidthMeters.provenance).toBe('source')
    expect(p1.lanes?.value).toBe(4)
    expect(p1.lanes?.provenance).toBe('source')
    expect(p1.oneWay).toBe(true)
    expect(p1.direction).toBe('forward')
    expect(p1.surface?.value).toBe('asphalt')
    expect(p1.surface?.provenance).toBe('source')
    expect(p1.sidewalks?.left).toBe(true)
    expect(p1.sidewalks?.right).toBe(true)
    expect(p1.cycleFacilities?.right).toBe(true)
    expect(p1.cycleFacilities?.kind).toBe('lane')
    expect(p1.bridge).toBe(true)
    expect(p1.tunnel).toBe(false)
    expect(p1.layer).toBe(2)

    // Strips include left sidewalk, carriageway, right bike lane, right sidewalk
    expect(p1.strips.some((s) => s.kind === 'carriageway')).toBe(true)
    expect(p1.strips.some((s) => s.kind === 'sidewalk' && s.side === 'left')).toBe(true)
    expect(p1.strips.some((s) => s.kind === 'sidewalk' && s.side === 'right')).toBe(true)
    expect(p1.strips.some((s) => s.kind === 'bike_lane' && s.side === 'right')).toBe(true)

    const f2 = project.features.find((f) => f.id === 'osm_w302')!
    expect(f2).toBeDefined()
    const p2 = f2.roadProfile!
    expect(p2.name).toBe('Oak Street')
    expect(p2.highwayClass).toBe('residential')
    expect(p2.carriagewayWidthMeters.value).toBe(6) // fallback residential
    expect(p2.carriagewayWidthMeters.provenance).toBe('inferred')
    expect(p2.oneWay).toBe(false)
    expect(p2.direction).toBe('both')
    expect(p2.tunnel).toBe(true)
    expect(p2.bridge).toBe(false)
    expect(p2.layer).toBe(-1)
  })

  it('represents unknown facility presence distinctly from explicit absence and known presence', () => {
    const osmData = {
      elements: [
        {
          type: 'way',
          id: 401,
          tags: {
            highway: 'secondary',
            'sidewalk:both': 'yes',
            'cycleway:right': 'lane'
          },
          geometry: [
            { lon: -71.1, lat: 42.4 },
            { lon: -71.1, lat: 42.41 }
          ]
        },
        {
          type: 'way',
          id: 402,
          tags: {
            highway: 'secondary',
            sidewalk: 'no',
            cycleway: 'no'
          },
          geometry: [
            { lon: -71.2, lat: 42.4 },
            { lon: -71.2, lat: 42.41 }
          ]
        },
        {
          type: 'way',
          id: 403,
          tags: {
            highway: 'residential'
          },
          geometry: [
            { lon: -71.3, lat: 42.4 },
            { lon: -71.3, lat: 42.41 }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(osmData)

    // 1. Known presence (id 401)
    const fKnown = project.features.find((f) => f.id === 'osm_w401')!
    expect(fKnown.roadProfile?.sidewalks?.presence).toBe('present')
    expect(fKnown.roadProfile?.sidewalks?.leftPresence).toBe('present')
    expect(fKnown.roadProfile?.sidewalks?.rightPresence).toBe('present')
    expect(fKnown.roadProfile?.sidewalks?.provenance).toBe('source')
    expect(fKnown.roadProfile?.cycleFacilities?.presence).toBe('present')
    expect(fKnown.roadProfile?.cycleFacilities?.rightPresence).toBe('present')
    expect(fKnown.roadProfile?.cycleFacilities?.provenance).toBe('source')

    // 2. Explicit absence (id 402)
    const fAbsent = project.features.find((f) => f.id === 'osm_w402')!
    expect(fAbsent.roadProfile?.sidewalks?.presence).toBe('absent')
    expect(fAbsent.roadProfile?.sidewalks?.leftPresence).toBe('absent')
    expect(fAbsent.roadProfile?.sidewalks?.rightPresence).toBe('absent')
    expect(fAbsent.roadProfile?.sidewalks?.provenance).toBe('source')
    expect(fAbsent.roadProfile?.cycleFacilities?.presence).toBe('absent')
    expect(fAbsent.roadProfile?.cycleFacilities?.leftPresence).toBe('absent')
    expect(fAbsent.roadProfile?.cycleFacilities?.rightPresence).toBe('absent')
    expect(fAbsent.roadProfile?.cycleFacilities?.provenance).toBe('source')

    // 3. Unknown presence (id 403)
    const fUnknown = project.features.find((f) => f.id === 'osm_w403')!
    expect(fUnknown.roadProfile?.sidewalks?.presence).toBe('unknown')
    expect(fUnknown.roadProfile?.sidewalks?.leftPresence).toBe('unknown')
    expect(fUnknown.roadProfile?.sidewalks?.rightPresence).toBe('unknown')
    expect(fUnknown.roadProfile?.sidewalks?.provenance).toBe('inferred')
    expect(fUnknown.roadProfile?.cycleFacilities?.presence).toBe('unknown')
    expect(fUnknown.roadProfile?.cycleFacilities?.leftPresence).toBe('unknown')
    expect(fUnknown.roadProfile?.cycleFacilities?.rightPresence).toBe('unknown')
    expect(fUnknown.roadProfile?.cycleFacilities?.provenance).toBe('inferred')

    // 4. Overture source
    const overtureData = {
      features: [
        {
          id: 'ov_present',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.1, 42.4], [-71.1, 42.41]] },
          properties: {
            class: 'primary',
            subclass_rules: [{ value: 'sidewalk' }, { value: 'cycleway' }]
          }
        },
        {
          id: 'ov_absent',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.2, 42.4], [-71.2, 42.41]] },
          properties: {
            class: 'motorway',
            access_restrictions: [
              { mode: 'foot', access: 'prohibited' },
              { mode: 'bicycle', access: 'prohibited' }
            ]
          }
        },
        {
          id: 'ov_unknown',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.3, 42.4], [-71.3, 42.41]] },
          properties: {
            class: 'residential'
          }
        }
      ]
    }
    const ovProject = normalizeOverturePayload(overtureData)
    const fOvPresent = ovProject.features.find((f) => f.id === 'ov_present')!
    expect(fOvPresent.roadProfile?.sidewalks?.presence).toBe('present')
    expect(fOvPresent.roadProfile?.cycleFacilities?.presence).toBe('present')

    const fOvAbsent = ovProject.features.find((f) => f.id === 'ov_absent')!
    expect(fOvAbsent.roadProfile?.sidewalks?.presence).toBe('absent')
    expect(fOvAbsent.roadProfile?.cycleFacilities?.presence).toBe('absent')

    const fOvUnknown = ovProject.features.find((f) => f.id === 'ov_unknown')!
    expect(fOvUnknown.roadProfile?.sidewalks?.presence).toBe('unknown')
    expect(fOvUnknown.roadProfile?.cycleFacilities?.presence).toBe('unknown')
  })

  it('parses units explicitly and distinguishes missing, malformed, explicit zero, and negative values', () => {
    // Missing
    expect(parseOsmDimension(undefined).status).toBe('missing')
    expect(parseOsmDimension(null).status).toBe('missing')
    expect(parseOsmDimension('').status).toBe('missing')
    expect(parseOsmDimension('   ').status).toBe('missing')

    // Malformed
    expect(parseOsmDimension('unknown').status).toBe('malformed')
    expect(parseOsmDimension('wide').status).toBe('malformed')
    expect(parseOsmDimension('abc12').status).toBe('malformed')
    expect(parseOsmDimension(NaN).status).toBe('malformed')

    // Explicit zero
    const zeroDim = parseOsmDimension('0')
    expect(zeroDim.status).toBe('explicit_zero')
    expect(zeroDim.value).toBe(0)
    expect(parseOsmDimension(0).status).toBe('explicit_zero')
    expect(parseOsmDimension('0.0 m').status).toBe('explicit_zero')

    // Explicit negative
    const negDim = parseOsmDimension('-5 m')
    expect(negDim.status).toBe('explicit_negative')
    expect(negDim.value).toBe(-5)
    expect(parseOsmDimension(-2).status).toBe('explicit_negative')

    // Valid with metric units
    const mDim = parseOsmDimension('12.5 m')
    expect(mDim.status).toBe('valid')
    expect(mDim.value).toBe(12.5)
    expect(mDim.unit).toBe('m')

    const kmDim = parseOsmDimension('1.5 km')
    expect(kmDim.status).toBe('valid')
    expect(kmDim.value).toBe(1500)

    const cmDim = parseOsmDimension('250 cm')
    expect(cmDim.status).toBe('valid')
    expect(cmDim.value).toBe(2.5)

    // Imperial units: feet, inches, feet+inches
    const ftDim = parseOsmDimension('10 ft')
    expect(ftDim.status).toBe('valid')
    expect(ftDim.value).toBeCloseTo(3.048, 3)

    const feetInches = parseOsmDimension(`14'6"`)
    expect(feetInches.status).toBe('valid')
    expect(feetInches.value).toBeCloseTo(14 * 0.3048 + 6 * 0.0254, 3)

    // Plain number string
    const plain = parseOsmDimension('7.2')
    expect(plain.status).toBe('valid')
    expect(plain.value).toBe(7.2)
    expect(plain.unit).toBe('m')

    // Verify normalization preserves status on road and building profiles
    const testFeatures = normalizeOsmPayload({
      elements: [
        {
          type: 'way',
          id: 401,
          tags: { highway: 'residential', width: 'invalid_width', lanes: '0' },
          geometry: [{ lon: -71.1, lat: 42.4 }, { lon: -71.1, lat: 42.41 }]
        },
        {
          type: 'way',
          id: 402,
          tags: { building: 'yes', height: '-10 m', 'building:levels': 'invalid' },
          geometry: [{ lon: -71.1, lat: 42.4 }, { lon: -71.11, lat: 42.4 }, { lon: -71.11, lat: 42.41 }, { lon: -71.1, lat: 42.4 }]
        }
      ]
    }).features

    const road = testFeatures.find(f => f.id === 'osm_w401')!.roadProfile!
    expect(road.carriagewayWidthMeters.parsedStatus).toBe('malformed')
    expect(road.carriagewayWidthMeters.provenance).toBe('inferred')
    expect(road.lanes?.parsedStatus).toBe('explicit_zero')

    const bld = testFeatures.find(f => f.id === 'osm_w402')!.buildingProfile!
    expect(bld.heightMeters?.parsedStatus).toBe('explicit_negative')
    expect(bld.heightMeters?.provenance).toBe('inferred')
    expect(bld.levels?.parsedStatus).toBe('malformed')
  })

  it('reports incomplete geometry or missing relation members without making the rest of a usable download inaccessible', () => {
    const rawOsm = {
      elements: [
        // Usable road
        {
          type: 'way',
          id: 501,
          tags: { highway: 'residential', name: 'Valid Street' },
          geometry: [
            { lon: -71.1, lat: 42.4 },
            { lon: -71.1, lat: 42.41 }
          ]
        },
        // Way with incomplete geometry (only 1 node resolved)
        {
          type: 'way',
          id: 502,
          tags: { highway: 'service', name: 'Broken Way' },
          nodes: [1001, 1002] // 1002 missing
        },
        // Node 1001 exists
        {
          type: 'node',
          id: 1001,
          lat: 42.4,
          lon: -71.12
        },
        // Usable way with partial missing nodes but still >= 2 resolved
        {
          type: 'way',
          id: 503,
          tags: { highway: 'residential', name: 'Partially Missing Nodes' },
          nodes: [1001, 9999, 1003]
        },
        {
          type: 'node',
          id: 1003,
          lat: 42.42,
          lon: -71.12
        },
        // Building relation with missing member way
        {
          type: 'relation',
          id: 601,
          tags: { type: 'multipolygon', building: 'yes' },
          members: [
            { type: 'way', ref: 504, role: 'outer' },
            { type: 'way', ref: 9998, role: 'inner' } // missing member
          ]
        },
        // Way 504 is closed outer ring
        {
          type: 'way',
          id: 504,
          tags: {},
          geometry: [
            { lon: -71.2, lat: 42.5 },
            { lon: -71.21, lat: 42.5 },
            { lon: -71.21, lat: 42.51 },
            { lon: -71.2, lat: 42.5 }
          ]
        },
        // Relation that completely fails to assemble outer ring
        {
          type: 'relation',
          id: 602,
          tags: { type: 'multipolygon', building: 'yes' },
          members: [
            { type: 'way', ref: 9997, role: 'outer' } // non-existent
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)

    // The rest of the download remains completely usable:
    // Feature 501 (valid road), Feature 503 (partially missing node, but resolved), Feature 601 (relation building with missing inner member)
    expect(project.features.some((f) => f.id === 'osm_w501')).toBe(true)
    expect(project.features.some((f) => f.id === 'osm_w503')).toBe(true)
    expect(project.features.some((f) => f.id === 'osm_r601')).toBe(true)
    // Broken way 502 and unbuildable relation 602 are excluded from features
    expect(project.features.some((f) => f.id === 'osm_w502')).toBe(false)
    expect(project.features.some((f) => f.id === 'osm_r602')).toBe(false)

    // Warnings are attached to the feature itself
    const f503 = project.features.find((f) => f.id === 'osm_w503')!
    expect(f503.warnings).toBeDefined()
    expect(f503.warnings!.some((w) => w.includes('Missing coordinates for nodes: 9999'))).toBe(true)

    const r601 = project.features.find((f) => f.id === 'osm_r601')!
    expect(r601.warnings).toBeDefined()
    expect(r601.warnings!.some((w) => w.includes('Member way w9998 missing'))).toBe(true)

    // Warnings are also aggregated in project.warnings for download reporting
    expect(project.warnings).toBeDefined()
    expect(project.warnings!.some((w) => w.includes('w502: Incomplete geometry'))).toBe(true)
    expect(project.warnings!.some((w) => w.includes('r602: Failed to form any closed outer ring'))).toBe(true)
    expect(project.warnings!.some((w) => w.includes('Member way w9998 missing'))).toBe(true)
  })

  it('defines explicit semantic kinds: building, road, sidewalk, bike facility, junction, and unsupported', () => {
    // 1. OSM semantic kinds
    expect(determineOsmSemanticKind({ building: 'yes' })).toBe('building')
    expect(determineOsmSemanticKind({ highway: 'primary' })).toBe('road')
    expect(determineOsmSemanticKind({ highway: 'footway', footway: 'sidewalk' })).toBe('sidewalk')
    expect(determineOsmSemanticKind({ highway: 'sidewalk' })).toBe('sidewalk')
    expect(determineOsmSemanticKind({ highway: 'cycleway' })).toBe('bike_facility')
    expect(determineOsmSemanticKind({ bicycle: 'designated', highway: 'path' })).toBe('bike_facility')
    expect(determineOsmSemanticKind({ 'area:highway': 'junction' })).toBe('junction')
    expect(determineOsmSemanticKind({ junction: 'yes' })).toBe('junction')
    expect(determineOsmSemanticKind({ amenity: 'parking' })).toBe('unsupported')

    // 2. Overture semantic kinds
    expect(determineOvertureSemanticKind({ overture_type: 'building' })).toBe('building')
    expect(determineOvertureSemanticKind({ properties: { theme: 'buildings' } })).toBe('building')
    expect(determineOvertureSemanticKind({ overture_type: 'segment', properties: { subtype: 'road' } })).toBe('road')
    expect(determineOvertureSemanticKind({ properties: { subtype: 'sidewalk' } })).toBe('sidewalk')
    expect(determineOvertureSemanticKind({ properties: { subtype: 'cycleway' } })).toBe('bike_facility')
    expect(determineOvertureSemanticKind({ overture_type: 'connector' })).toBe('junction')
    expect(determineOvertureSemanticKind({ properties: { subtype: 'junction' } })).toBe('junction')
    expect(determineOvertureSemanticKind({ properties: { subtype: 'parking' } })).toBe('unsupported')
  })

  it('ensures polygon geometry alone does not imply "building" in normalization and validation', () => {
    // 1. Overture polygon with non-building attributes must NOT be normalized as building
    const overtureParkingPoly = {
      type: 'FeatureCollection',
      features: [
        {
          id: 'poly_park_1',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.11, 42.41],
                [-71.10, 42.41],
                [-71.10, 42.42],
                [-71.11, 42.42],
                [-71.11, 42.41]
              ]
            ]
          },
          properties: {
            subtype: 'parking',
            amenity: 'parking'
          }
        },
        {
          id: 'poly_junction_1',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.12, 42.41],
                [-71.11, 42.41],
                [-71.11, 42.42],
                [-71.12, 42.42],
                [-71.12, 42.41]
              ]
            ]
          },
          properties: {
            subtype: 'junction'
          }
        }
      ]
    }

    const ovProject = normalizeOverturePayload(overtureParkingPoly)
    const parkFeat = ovProject.features.find((f) => f.id === 'poly_park_1')!
    expect(parkFeat).toBeDefined()
    expect(parkFeat.kind).toBe('unsupported')
    expect(parkFeat.role).toBe('unsupported')
    expect(parkFeat.buildingProfile).toBeUndefined()
    expect(parkFeat.sourceGeometry.type).toBe('Polygon')

    const juncFeat = ovProject.features.find((f) => f.id === 'poly_junction_1')!
    expect(juncFeat).toBeDefined()
    expect(juncFeat.kind).toBe('junction')
    expect(juncFeat.role).toBe('junction')
    expect(juncFeat.buildingProfile).toBeUndefined()

    // Validation of raw GeoJSON must not classify polygon geometry as building
    const ovVal = validateImportPayload(overtureParkingPoly)
    expect(ovVal.stats.categories.building || 0).toBe(0)
    expect(ovVal.stats.categories.junction).toBe(1)
    expect(ovVal.stats.categories.unsupported).toBe(1)

    // 2. OSM closed polygon way with non-building tags must NOT be normalized as building
    const osmNonBuildingPolys = {
      elements: [
        {
          type: 'way',
          id: 401,
          tags: { amenity: 'parking' },
          geometry: [
            { lon: -71.11, lat: 42.41 },
            { lon: -71.10, lat: 42.41 },
            { lon: -71.10, lat: 42.42 },
            { lon: -71.11, lat: 42.42 },
            { lon: -71.11, lat: 42.41 }
          ]
        },
        {
          type: 'way',
          id: 402,
          tags: { highway: 'pedestrian', area: 'yes' },
          geometry: [
            { lon: -71.12, lat: 42.41 },
            { lon: -71.11, lat: 42.41 },
            { lon: -71.11, lat: 42.42 },
            { lon: -71.12, lat: 42.42 },
            { lon: -71.12, lat: 42.41 }
          ]
        }
      ]
    }

    const osmProject = normalizeOsmPayload(osmNonBuildingPolys)
    const osmPark = osmProject.features.find((f) => f.id === 'osm_w401')!
    expect(osmPark).toBeDefined()
    expect(osmPark.kind).toBe('unsupported')
    expect(osmPark.role).toBe('unsupported')
    expect(osmPark.buildingProfile).toBeUndefined()
    expect(osmPark.sourceGeometry.type).toBe('Polygon')

    const osmPlaza = osmProject.features.find((f) => f.id === 'osm_w402')!
    expect(osmPlaza).toBeDefined()
    expect(osmPlaza.kind).toBe('road')
    expect(osmPlaza.role).toBe('road')
    expect(osmPlaza.buildingProfile).toBeUndefined()
    expect(osmPlaza.sourceGeometry.type).toBe('Polygon')

    // Validation of OSM elements must not count parking polygon as building
    const osmVal = validateImportPayload(osmNonBuildingPolys)
    expect(osmVal.stats.categories.building || 0).toBe(0)
    expect(osmVal.stats.categories.road).toBe(1)
    expect(osmVal.stats.categories.unsupported).toBe(1)
  })

  it('stores normalized values with units and per-value provenance: source-provided and inferred', () => {
    const rawOsm = {
      elements: [
        {
          type: 'way',
          id: 601,
          tags: {
            highway: 'secondary',
            name: 'Oak Ave',
            width: '12 m',
            lanes: '3',
            maxspeed: '35 mph',
            surface: 'asphalt'
          },
          geometry: [
            { lon: -71.1, lat: 42.4 },
            { lon: -71.1, lat: 42.405 }
          ]
        },
        {
          type: 'way',
          id: 602,
          tags: {
            building: 'yes',
            height: '15 m',
            'building:levels': '4'
          },
          geometry: [
            { lon: -71.11, lat: 42.4 },
            { lon: -71.109, lat: 42.4 },
            { lon: -71.109, lat: 42.401 },
            { lon: -71.11, lat: 42.401 },
            { lon: -71.11, lat: 42.4 }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)
    const road = project.features.find((f) => f.id === 'osm_w601')!
    expect(road).toBeDefined()
    const rp = road.roadProfile!

    // Source-provided carriageway width with units
    expect(rp.carriagewayWidthMeters.value).toBe(12)
    expect(rp.carriagewayWidthMeters.unit).toBe('m')
    expect(rp.carriagewayWidthMeters.provenance).toBe('source')

    // Source-provided lanes with units
    expect(rp.lanes?.value).toBe(3)
    expect(rp.lanes?.unit).toBe('count')
    expect(rp.lanes?.provenance).toBe('source')

    // Source-provided speed limit with units
    expect(rp.speedLimit?.value).toBe(35)
    expect(rp.speedLimit?.unit).toBe('mph')
    expect(rp.speedLimit?.provenance).toBe('source')

    // Strips have width, units, and provenance
    expect(rp.strips.length).toBeGreaterThan(0)
    const cwStrip = rp.strips.find((s) => s.kind === 'carriageway')!
    expect(cwStrip.widthMeters).toBe(12)
    expect(cwStrip.width?.value).toBe(12)
    expect(cwStrip.width?.unit).toBe('m')
    expect(cwStrip.width?.provenance).toBe('source')

    // Total corridor width with units and provenance
    expect(rp.totalCorridorWidth).toBeDefined()
    expect(rp.totalCorridorWidth?.unit).toBe('m')

    const bldg = project.features.find((f) => f.id === 'osm_w602')!
    expect(bldg).toBeDefined()
    const bp = bldg.buildingProfile!

    // Source-provided height with units
    expect(bp.heightMeters?.value).toBe(15)
    expect(bp.heightMeters?.unit).toBe('m')
    expect(bp.heightMeters?.provenance).toBe('source')

    // Source-provided levels with units
    expect(bp.levels?.value).toBe(4)
    expect(bp.levels?.unit).toBe('levels')
    expect(bp.levels?.provenance).toBe('source')

    // Inferred footprint area with units
    expect(bp.footprintAreaSquareMeters).toBeDefined()
    expect(bp.footprintAreaSquareMeters?.unit).toBe('m²')
    expect(bp.footprintAreaSquareMeters?.provenance).toBe('inferred')
    expect(bp.footprintAreaSquareMeters?.value).toBeGreaterThan(0)
  })

  it('represents a street cross-section as ordered strips with kind, side, width, direction where relevant, and lateral placement relative to the source line', () => {
    const rawOsm = {
      elements: [
        {
          type: 'way',
          id: 701,
          tags: {
            highway: 'secondary',
            name: 'Cross Section Ave',
            width: '10',
            lanes: '2',
            oneway: 'yes',
            'sidewalk:both': 'yes',
            'cycleway:right': 'lane',
            'cycleway:left': 'lane',
            'cycleway:left:oneway': 'no'
          },
          nodes: [1, 2],
          geometry: [
            { lon: -71.109, lat: 42.401 },
            { lon: -71.109, lat: 42.403 }
          ]
        }
      ]
    }

    const project = normalizeOsmPayload(rawOsm)
    const road = project.features.find((f) => f.id === 'osm_w701')!
    expect(road).toBeDefined()
    const rp = road.roadProfile!

    // Strips must be present and ordered from left to right
    expect(rp.strips.length).toBe(5)
    // Expected order: left sidewalk, left bike lane, carriageway, right bike lane, right sidewalk
    const kinds = rp.strips.map((s) => s.kind)
    const sides = rp.strips.map((s) => s.side)
    expect(kinds).toEqual(['sidewalk', 'bike_lane', 'carriageway', 'bike_lane', 'sidewalk'])
    expect(sides).toEqual(['left', 'left', 'center', 'right', 'right'])

    // Every strip has width with units, lateralPlacement, direction where relevant
    for (let i = 0; i < rp.strips.length; i++) {
      const strip = rp.strips[i]
      expect(strip.widthMeters).toBeGreaterThan(0)
      expect(strip.width?.unit).toBe('m')
      expect(strip.width?.value).toBe(strip.widthMeters)
      expect(strip.lateralPlacement).toBeDefined()
      expect(strip.lateralPlacement?.orderIndex).toBe(i)
      expect(strip.lateralPlacement?.offsetMeters).toBe(strip.offsetMeters)

      // Offset check: ordered strictly ascending from left (negative) to right (positive)
      if (i > 0) {
        expect(strip.offsetMeters!).toBeGreaterThan(rp.strips[i - 1].offsetMeters!)
      }
    }

    // Check lateral placement offsets relative to source line
    // Explicit source width of 10m includes on-road bike lanes (1.5m each).
    // Effective vehicular carriageway is carved out: 10 - 3 = 7m (spans -3.5m to +3.5m).
    const cwStrip = rp.strips[2]
    expect(cwStrip.kind).toBe('carriageway')
    expect(cwStrip.widthMeters).toBe(7)
    expect(cwStrip.offsetMeters).toBe(0)
    expect(cwStrip.lateralPlacement?.innerOffsetMeters).toBe(-3.5)
    expect(cwStrip.lateralPlacement?.outerOffsetMeters).toBe(3.5)
    expect(cwStrip.direction).toBe('forward') // oneway: yes

    // Left bike lane: width 1.5m inside curb-to-curb roadway -> inner edge -3.5m, outer edge -5.0m, center -4.25m
    const leftBike = rp.strips[1]
    expect(leftBike.kind).toBe('bike_lane')
    expect(leftBike.side).toBe('left')
    expect(leftBike.widthMeters).toBe(1.5)
    expect(leftBike.offsetMeters).toBe(-4.25)
    expect(leftBike.lateralPlacement?.innerOffsetMeters).toBe(-3.5)
    expect(leftBike.lateralPlacement?.outerOffsetMeters).toBe(-5)
    expect(leftBike.direction).toBe('both') // cycleway:left:oneway=no

    // Left sidewalk: width 1.8m outside curb-to-curb roadway -> inner edge -5.0m, outer edge -6.8m, center -5.9m
    const leftSw = rp.strips[0]
    expect(leftSw.kind).toBe('sidewalk')
    expect(leftSw.side).toBe('left')
    expect(leftSw.widthMeters).toBe(1.8)
    expect(leftSw.offsetMeters).toBe(-5.9)
    expect(leftSw.lateralPlacement?.innerOffsetMeters).toBe(-5)
    expect(leftSw.lateralPlacement?.outerOffsetMeters).toBe(-6.8)
    expect(leftSw.direction).toBe('both') // sidewalks are bidirectional

    // Right bike lane: width 1.5m inside curb-to-curb roadway -> inner edge +3.5m, outer edge +5.0m, center +4.25m
    const rightBike = rp.strips[3]
    expect(rightBike.kind).toBe('bike_lane')
    expect(rightBike.side).toBe('right')
    expect(rightBike.widthMeters).toBe(1.5)
    expect(rightBike.offsetMeters).toBe(4.25)
    expect(rightBike.lateralPlacement?.innerOffsetMeters).toBe(3.5)
    expect(rightBike.lateralPlacement?.outerOffsetMeters).toBe(5)
    expect(rightBike.direction).toBe('forward')

    // Right sidewalk: width 1.8m outside curb-to-curb roadway -> inner edge +5.0m, outer edge +6.8m, center +5.9m
    const rightSw = rp.strips[4]
    expect(rightSw.kind).toBe('sidewalk')
    expect(rightSw.side).toBe('right')
    expect(rightSw.widthMeters).toBe(1.8)
    expect(rightSw.offsetMeters).toBe(5.9)
    expect(rightSw.lateralPlacement?.innerOffsetMeters).toBe(5)
    expect(rightSw.lateralPlacement?.outerOffsetMeters).toBe(6.8)
    expect(rightSw.direction).toBe('both')

    // Total corridor width = 6.8 (left) + 6.8 (right) = 13.6m (roadway is exactly 10m, bike lanes not double-counted)
    expect(rp.totalCorridorWidthMeters).toBeCloseTo(13.6, 2)
    // Recalculating strips maintains order and updates lateral placement
    rp.carriagewayWidthMeters.value = 12
    rp.carriagewayWidthMeters.provenance = 'user_edited'
    recalculateRoadStrips(rp)

    expect(rp.strips.length).toBe(5)
    expect(rp.strips.map((s) => s.kind)).toEqual(['sidewalk', 'bike_lane', 'carriageway', 'bike_lane', 'sidewalk'])
    expect(rp.strips[2].widthMeters).toBe(12)
    expect(rp.strips[2].offsetMeters).toBe(0)
    expect(rp.strips[1].offsetMeters).toBe(-6.75) // -(6 + 0.75)
    expect(rp.strips[0].offsetMeters).toBe(-8.4) // -(6 + 1.5 + 0.9)
    expect(rp.strips[3].offsetMeters).toBe(6.75)
    expect(rp.strips[4].offsetMeters).toBe(8.4)
    for (let i = 0; i < rp.strips.length; i++) {
      expect(rp.strips[i].lateralPlacement?.orderIndex).toBe(i)
    }
  })

  it('rejects project envelopes in normalizeOverturePayload and normalizeOsmPayload', () => {
    const projectEnv = {
      schemaVersion: '2.0.0',
      sourceMetadata: { source: 'osm' },
      features: []
    }

    expect(() => {
      normalizeOverturePayload(projectEnv)
    }).toThrow(/Cannot normalize project envelope as raw Overture GeoJSON/)

    expect(() => {
      normalizeOsmPayload(projectEnv)
    }).toThrow(/Cannot normalize project envelope as raw OSM data/)
  })

  it('extracts and preserves source attribution and applicable licenses in normalizeOsmPayload', () => {
    const osmData = {
      metadata: {
        source: 'osm',
        areaName: 'Medford Square'
      },
      elements: [
        {
          type: 'way',
          id: 101,
          nodes: [1, 2],
          tags: {
            highway: 'secondary',
            attribution: 'Office of Geographic and Environmental Information (MassGIS)',
            source: 'massgis'
          }
        },
        {
          type: 'way',
          id: 102,
          nodes: [2, 3],
          tags: {
            highway: 'residential'
          }
        },
        { type: 'node', id: 1, lat: 42.41, lon: -71.11 },
        { type: 'node', id: 2, lat: 42.41, lon: -71.1 },
        { type: 'node', id: 3, lat: 42.41, lon: -71.09 }
      ]
    }
    const project = normalizeOsmPayload(osmData)
    expect(project.sourceMetadata.source).toBe('osm')
    expect(project.sourceMetadata.attribution).toContain('OpenStreetMap')
    expect(project.sourceMetadata.attribution).toContain('MassGIS')
    expect(project.sourceMetadata.license).toBe('ODbL-1.0')
    expect(project.sourceMetadata.licenses).toContain('ODbL-1.0')
    expect(project.sourceMetadata.sourceAttributions?.length).toBeGreaterThanOrEqual(2)

    const massgisFeat = project.features.find((f) => f.id === 'osm_w101')!
    expect(massgisFeat.sourceAttribution).toBe('Office of Geographic and Environmental Information (MassGIS)')
  })

  it('aggregates multi-source licenses and attribution from Overture features in normalizeOverturePayload', () => {
    const overtureData = {
      type: 'FeatureCollection',
      metadata: {
        release: '2026-09-17.0'
      },
      features: [
        {
          id: 'segment_osm',
          overture_type: 'segment',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-71.11, 42.41],
              [-71.10, 42.41]
            ]
          },
          properties: {
            class: 'primary',
            sources: [
              {
                dataset: 'OpenStreetMap',
                license: 'ODbL-1.0',
                record_id: 'w123'
              }
            ]
          }
        },
        {
          id: 'bldg_foursquare',
          overture_type: 'building',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-71.11, 42.41],
                [-71.10, 42.41],
                [-71.10, 42.42],
                [-71.11, 42.42],
                [-71.11, 42.41]
              ]
            ]
          },
          properties: {
            sources: [
              {
                dataset: 'Foursquare',
                license: 'Apache-2.0',
                record_id: 'fq_456'
              },
              {
                dataset: 'Microsoft ML Buildings',
                license: 'CDLA-Permissive-2.0'
              }
            ]
          }
        }
      ]
    }

    const project = normalizeOverturePayload(overtureData)
    expect(project.sourceMetadata.source).toBe('overture')
    expect(project.sourceMetadata.attribution).toContain('Overture Maps Foundation')
    expect(project.sourceMetadata.attribution).toContain('OpenStreetMap contributors')
    expect(project.sourceMetadata.license).toBe('CDLA-Permissive-2.0')
    expect(project.sourceMetadata.licenses).toContain('CDLA-Permissive-2.0')
    expect(project.sourceMetadata.licenses).toContain('ODbL-1.0')
    expect(project.sourceMetadata.licenses).toContain('Apache-2.0')

    const osmFeat = project.features.find((f) => f.id === 'segment_osm')!
    expect(osmFeat.sourceLicense).toBe('ODbL-1.0')

    const fqFeat = project.features.find((f) => f.id === 'bldg_foursquare')!
    expect(fqFeat.sourceLicense).toContain('Apache-2.0')
    expect(fqFeat.sourceLicense).toContain('CDLA-Permissive-2.0')
  })

  describe('OSM relation assembly, holes, source-qualified IDs, and source-property preservation with representative input', () => {
    it('correctly assembles multipolygon relation with outer and inner hole boundaries, source-qualified IDs, and preserved source properties', () => {
      const rawOsm = complexBuildingsFixture
      const project = normalizeOsmPayload(rawOsm, { source: 'osm' })
      expect(project).toBeDefined()
      expect(project.schemaVersion).toBe('1.0.0')
      expect(project.sourceMetadata.source).toBe('osm')

      // Relation 2101 is a commercial building multipolygon with outer way 21011 and inner hole way 21012
      const relFeature = project.features.find((f) => f.id === 'osm_r2101')
      expect(relFeature).toBeDefined()
      if (!relFeature) return

      // Check source-qualified ID convention
      expect(relFeature.id).toBe('osm_r2101')
      expect(relFeature.sourceId).toBe('2101')
      expect(relFeature.role).toBe('building')
      expect(relFeature.kind).toBe('building')

      // Check sourceReference preservation
      expect(relFeature.sourceReference).toBeDefined()
      expect(relFeature.sourceReference?.type).toBe('relation')
      expect(relFeature.sourceReference?.id).toBe(2101)
      expect(relFeature.sourceReference?.members).toBeDefined()
      expect(relFeature.sourceReference?.members?.length).toBe(2)
      expect(relFeature.sourceReference?.members?.[0]?.ref).toBe(21011)
      expect(relFeature.sourceReference?.members?.[0]?.role).toBe('outer')
      expect(relFeature.sourceReference?.members?.[1]?.ref).toBe(21012)
      expect(relFeature.sourceReference?.members?.[1]?.role).toBe('inner')

      // Check source property preservation
      expect(relFeature.properties.building).toBe('commercial')
      expect(relFeature.properties['building:levels']).toBe('6')
      expect(relFeature.properties['building:material']).toBe('glass')
      expect(relFeature.properties['roof:material']).toBe('concrete')
      expect(relFeature.sourceReference?.tags?.['building:material']).toBe('glass')
      expect(relFeature.sourceReference?.tags?.['roof:material']).toBe('concrete')

      // Check building profile parsed attributes
      expect(relFeature.buildingProfile?.levels?.value).toBe(6)
      expect(relFeature.buildingProfile?.heightMeters?.value).toBe(18) // 6 levels * 3.0m inferred
      expect(relFeature.buildingProfile?.heightMeters?.provenance).toBe('inferred')
      // Check assembled geometry: Polygon with outer ring and inner hole ring
      expect(relFeature.sourceGeometry.type).toBe('Polygon')
      const polyGeom = relFeature.sourceGeometry as GeoJSON.Polygon
      expect(polyGeom.coordinates.length).toBe(2) // 1 outer + 1 inner hole

      // Outer ring has 5 coordinates (closed)
      const outerRing = polyGeom.coordinates[0]!
      expect(outerRing.length).toBe(5)
      expect(outerRing[0]).toEqual(outerRing[outerRing.length - 1])

      // Inner ring has 5 coordinates (closed)
      const innerRing = polyGeom.coordinates[1]!
      expect(innerRing.length).toBe(5)
      expect(innerRing[0]).toEqual(innerRing[innerRing.length - 1])

      // Verify member ways 21011 and 21012 are NOT duplicated as standalone features
      expect(project.features.some((f) => f.id === 'osm_w21011')).toBe(false)
      expect(project.features.some((f) => f.id === 'osm_w21012')).toBe(false)

      // Standalone ways 2201 and 2202 remain present with osm_w-qualified IDs and preserved source properties
      const way2201 = project.features.find((f) => f.id === 'osm_w2201')
      expect(way2201).toBeDefined()
      if (way2201) {
        expect(way2201.id).toBe('osm_w2201')
        expect(way2201.sourceId).toBe('2201')
        expect(way2201.sourceReference?.type).toBe('way')
        expect(way2201.sourceReference?.id).toBe(2201)
        expect(way2201.properties['building:material']).toBe('concrete')
        expect(way2201.properties['min_height']).toBe('0')
        expect(way2201.buildingProfile?.heightMeters?.value).toBe(70)
      }

      const way2202 = project.features.find((f) => f.id === 'osm_w2202')
      expect(way2202).toBeDefined()
      if (way2202) {
        expect(way2202.id).toBe('osm_w2202')
        expect(way2202.sourceId).toBe('2202')
        expect(way2202.sourceReference?.type).toBe('way')
        expect(way2202.sourceReference?.id).toBe(2202)
        expect(way2202.properties['building:material']).toBe('glass')
        expect(way2202.properties['min_height']).toBe('70')
        expect(way2202.buildingProfile?.heightMeters?.value).toBe(105)
      }
    })
  })

  describe('Overture category mapping and segment-relative attributes, including missing facility information', () => {
    it('maps Overture categories (building, segment/road, sidewalk, cycleway, connector/junction) accurately and preserves segment-relative attributes', () => {
      const overtureCategoriesData = {
        type: 'FeatureCollection',
        metadata: {
          source: 'Overture Maps Foundation',
          release: '2026-10-01.0'
        },
        features: [
          // 1. Building feature
          {
            id: 'ov_bldg_1',
            overture_type: 'building',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-71.12, 42.42],
                  [-71.11, 42.42],
                  [-71.11, 42.43],
                  [-71.12, 42.43],
                  [-71.12, 42.42]
                ]
              ]
            },
            properties: {
              theme: 'buildings',
              height: 25.5,
              num_floors: 7
            }
          },
          // 2. Segment with road class and segment-relative partitioned attributes
          {
            id: 'ov_road_seg_1',
            overture_type: 'segment',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.12, 42.42],
                [-71.12, 42.44]
              ]
            },
            properties: {
              theme: 'transportation',
              subtype: 'road',
              class: 'primary',
              connectors: [
                { connector_id: 'conn_north', at: 1.0 },
                { connector_id: 'conn_south', at: 0.0 }
              ],
              subclass_rules: [
                { value: 'link', between: [0.0, 0.5] },
                { value: 'primary', between: [0.5, 1.0] }
              ],
              width_rules: [
                { value: 7.5, between: [0.0, 0.5] },
                { value: 12.0, between: [0.5, 1.0] }
              ]
            }
          },
          // 3. Segment with missing facility information under default policy
          {
            id: 'ov_road_no_facility',
            overture_type: 'segment',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.11, 42.42],
                [-71.11, 42.43]
              ]
            },
            properties: {
              theme: 'transportation',
              subtype: 'road',
              class: 'tertiary'
              // Notice: no sidewalk, no cycleway, no facilities defined at all
            }
          },
          // 4. Standalone sidewalk segment
          {
            id: 'ov_sw_1',
            overture_type: 'segment',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.121, 42.42],
                [-71.121, 42.44]
              ]
            },
            properties: {
              theme: 'transportation',
              subtype: 'sidewalk'
            }
          },
          // 5. Standalone cycleway segment
          {
            id: 'ov_cycle_1',
            overture_type: 'segment',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-71.119, 42.42],
                [-71.119, 42.44]
              ]
            },
            properties: {
              theme: 'transportation',
              subtype: 'cycleway'
            }
          }
        ]
      }

      const project = normalizeOverturePayload(overtureCategoriesData)
      expect(project).toBeDefined()
      expect(project.sourceMetadata.source).toBe('overture')

      // Check category mappings
      // 1. Building
      const bldg = project.features.find((f) => f.id === 'ov_bldg_1')
      expect(bldg).toBeDefined()
      expect(bldg?.role).toBe('building')
      expect(bldg?.kind).toBe('building')
      expect(bldg?.buildingProfile?.heightMeters?.value).toBe(25.5)
      expect(bldg?.buildingProfile?.levels?.value).toBe(7)

      // 2. Segment-relative partitioned subsegments
      const sub1 = project.features.find((f) => f.id === 'ov_road_seg_1_sub_1')
      const sub2 = project.features.find((f) => f.id === 'ov_road_seg_1_sub_2')
      expect(sub1).toBeDefined()
      expect(sub2).toBeDefined()
      expect(sub1?.role).toBe('road')
      expect(sub2?.role).toBe('road')
      expect(sub1?.segmentRelative?.parentSourceId).toBe('ov_road_seg_1')
      expect(sub1?.segmentRelative?.between).toEqual([0.0, 0.5])
      expect(sub2?.segmentRelative?.parentSourceId).toBe('ov_road_seg_1')
      expect(sub2?.segmentRelative?.between).toEqual([0.5, 1.0])
      expect(sub1?.roadProfile?.carriagewayWidthMeters?.value).toBe(7.5)
      expect(sub2?.roadProfile?.carriagewayWidthMeters?.value).toBe(12.0)

      // 3. Road segment with missing facility information
      const roadNoFacility = project.features.find((f) => f.id === 'ov_road_no_facility')
      expect(roadNoFacility).toBeDefined()
      expect(roadNoFacility?.role).toBe('road')
      expect(roadNoFacility?.roadProfile?.sidewalks?.presence).toBe('unknown')
      expect(roadNoFacility?.roadProfile?.sidewalks?.leftPresence).toBe('unknown')
      expect(roadNoFacility?.roadProfile?.sidewalks?.rightPresence).toBe('unknown')
      expect(roadNoFacility?.roadProfile?.cycleFacilities?.presence).toBe('unknown')
      expect(roadNoFacility?.roadProfile?.cycleFacilities?.leftPresence).toBe('unknown')
      expect(roadNoFacility?.roadProfile?.cycleFacilities?.rightPresence).toBe('unknown')
      // Missing facility information means inferred flag is false for explicit presence
      // and strips do not include sidewalks or cycle tracks under default 'none' policy
      expect(roadNoFacility?.roadProfile?.strips.some((s) => s.kind === 'sidewalk')).toBe(false)
      expect(roadNoFacility?.roadProfile?.strips.some((s) => s.kind === 'bike_lane')).toBe(false)

      // 4. Standalone sidewalk mapping
      const sw = project.features.find((f) => f.id === 'ov_sw_1')
      expect(sw).toBeDefined()
      expect(sw?.role).toBe('sidewalk')
      expect(sw?.kind).toBe('sidewalk')

      // 5. Standalone cycleway mapping
      const cycle = project.features.find((f) => f.id === 'ov_cycle_1')
      expect(cycle).toBeDefined()
      expect(cycle?.role).toBe('bike_facility')
      expect(cycle?.kind).toBe('bike_facility')
    })
  })
})
