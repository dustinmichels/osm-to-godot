import { describe, it, expect } from 'bun:test'
import {
  OVERTURE_PRESET_CACHES,
  matchesBBox,
  getOvertureCacheKey,
  parseOvertureData,
  useOverture,
  createOvertureCommandFile,
  isOvertureCommandFile,
  analyzeOvertureThemes
} from './useOverture'
describe('useOverture caching', () => {
  it('has medford-y in OVERTURE_PRESET_CACHES with 306 features', () => {
    const medford = OVERTURE_PRESET_CACHES.find((p) => p.name === 'medford-y')
    expect(medford).toBeDefined()
    expect(medford!.payload.features.length).toBe(306)
    expect(medford!.payload.metadata.counts.segment).toBe(67)
    expect(medford!.payload.metadata.counts.building).toBe(48)
    expect(medford!.payload.metadata.counts.place).toBe(99)
    expect(medford!.payload.metadata.counts.address).toBe(92)
    expect(medford!.payload.metadata.source).toBe('Overture Maps Foundation')
  })

  it('matchesBBox matches medford-y bounds within tolerance', () => {
    const medford = OVERTURE_PRESET_CACHES.find((p) => p.name === 'medford-y')!
    const queryBox = {
      west: -71.1119,
      south: 42.4141,
      east: -71.1089,
      north: 42.4164
    }
    expect(matchesBBox(queryBox, medford.bbox)).toBe(true)

    const distantBox = {
      west: 4.89,
      south: 52.36,
      east: 4.9,
      north: 52.38
    }
    expect(matchesBBox(distantBox, medford.bbox)).toBe(false)
  })

  it('generates consistent cache key from bbox', () => {
    const box = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    expect(getOvertureCacheKey(box)).toBe('overture_cache_42.4141_-71.1119_42.4164_-71.1089')
  })

  it('getCachedPreset returns medford-y when given medford-y bbox', () => {
    const { getCachedPreset } = useOverture()
    const queryBox = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    const preset = getCachedPreset(queryBox)
    expect(preset).toBeDefined()
    expect(preset?.name).toBe('medford-y')
    expect(preset?.payload.features.length).toBe(306)
  })
})

describe('parseOvertureData and file-drop handling', () => {
  it('parses valid arbitrary Overture GeoJSON FeatureCollection', () => {
    const sampleOverture = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'seg_1',
          properties: {
            id: 'seg_1',
            overture_type: 'segment',
            class: 'primary',
            subclass: 'link'
          },
          geometry: {
            type: 'LineString',
            coordinates: [[-71.1, 42.4], [-71.11, 42.41]]
          }
        },
        {
          type: 'Feature',
          id: 'bld_1',
          properties: {
            id: 'bld_1',
            overture_type: 'building',
            height: 12
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[[-71.1, 42.4], [-71.1, 42.41], [-71.11, 42.41], [-71.1, 42.4]]]
          }
        }
      ]
    }

    const res = parseOvertureData(JSON.stringify(sampleOverture))
    expect(res.success).toBe(true)
    expect(res.payload?.features.length).toBe(2)
    expect(res.payload?.type).toBe('FeatureCollection')
  })

  it('creates and rejects bounding-box command files as map data', () => {
    const box = {
      west: -71.111885,
      south: 42.414131,
      east: -71.108851,
      north: 42.416392
    }
    const commandFile = createOvertureCommandFile(box)
    expect(commandFile.type).toBe('command_file')
    expect(commandFile.metadata.command).toContain('mise run fetch-overture')
    expect(commandFile.metadata.bbox).toEqual([-71.111885, 42.414131, -71.108851, 42.416392])
    expect(isOvertureCommandFile(commandFile)).toBe(true)

    const res = parseOvertureData(JSON.stringify(commandFile))
    expect(res.success).toBe(false)
    expect(res.isCommandFile).toBe(true)
    expect(res.error).toContain('command file')
    expect(res.error).toContain('NOT downloaded map data')
  })

  it('rejects invalid JSON string', () => {
    const res = parseOvertureData('{ broken json')
    expect(res.success).toBe(false)
    expect(res.error).toContain('Invalid JSON')
  })

  it('rejects project files and unsupported schema versions instead of parsing as Overture GeoJSON', () => {
    const v2Project = {
      schemaVersion: '2.0.0',
      sourceMetadata: { source: 'osm' },
      features: [
        {
          id: 'feat_1',
          role: 'road',
          sourceGeometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }
        }
      ]
    }
    const resV2 = parseOvertureData(JSON.stringify(v2Project))
    expect(resV2.success).toBe(false)
    expect(resV2.error).toContain('Unsupported project schema version')
    expect(resV2.error).toContain('2.0.0')

    const v1Project = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      features: []
    }
    const resV1 = parseOvertureData(JSON.stringify(v1Project))
    expect(resV1.success).toBe(false)
    expect(resV1.error).toContain('editor project file')
    expect(resV1.error).toContain('not raw Overture GeoJSON')
  })
  it('rejects exported Godot scene payloads instead of parsing as raw Overture GeoJSON', () => {
    const scenePayload = {
      type: 'FeatureCollection',
      generator: 'osm-to-godot-editor',
      editorPayloadVersion: '1.0.0',
      metadata: {
        sourceMetadata: { source: 'overture' }
      },
      features: [
        {
          type: 'Feature',
          id: 'surf_1',
          properties: { role: 'road_surface' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
          }
        }
      ]
    }
    const res = parseOvertureData(scenePayload)
    expect(res.success).toBe(false)
    expect(res.error).toContain('exported Godot scene payload')
    expect(res.error).toContain('saved Project JSON file')
  })


  it('loadOvertureFileContent populates lastExportPayload on success and surfaces error on invalid file', () => {
    const { loadOvertureFileContent, lastExportPayload, errorMessage } = useOverture()
    const sample = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { overture_type: 'segment' },
          geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }
        }
      ]
    }
    const loaded = loadOvertureFileContent(JSON.stringify(sample), 'test.geojson')
    expect(loaded).toBeDefined()
    expect(lastExportPayload.value?.features.length).toBe(1)
    expect(errorMessage.value).toBeNull()

    // Now try invalid command file
    const cmd = {
      note: 'command file',
      metadata: { command: 'fetch' }
    }
    const badResult = loadOvertureFileContent(JSON.stringify(cmd))
    expect(badResult).toBeNull()
    expect(errorMessage.value).toContain('command file')
  })
})

describe('useOverture fetchFromBridge', () => {
  it('successfully fetches and stores Overture GeoJSON from local bridge', async () => {
    const { fetchFromBridge, lastExportPayload, statusMessage, errorMessage } = useOverture()
    const samplePayload = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        bbox: [-71.2, 42.3, -71.1, 42.4],
        counts: { segment: 2 },
        total_features: 2
      },
      features: [
        {
          type: 'Feature',
          properties: { overture_type: 'segment' },
          geometry: { type: 'LineString', coordinates: [[-71.2, 42.3], [-71.1, 42.4]] }
        }
      ]
    }

    const mockBridge = async () => {
      return samplePayload
    }

    const result = await fetchFromBridge({ west: -71.2, south: 42.3, east: -71.1, north: 42.4 }, mockBridge)
    expect(result).toBeDefined()
    expect(result?.features.length).toBe(1)
    expect(lastExportPayload.value?.features.length).toBe(1)
    expect(statusMessage.value).toContain('Acquired 1 features from local Overture downloader')
    expect(errorMessage.value).toBeNull()
  })

  it('surfaces error when bridge returns failure or null', async () => {
    const { fetchFromBridge, errorMessage } = useOverture()
    const failingBridge = async () => null

    const result = await fetchFromBridge({ west: -71.2, south: 42.3, east: -71.1, north: 42.4 }, failingBridge)
    expect(result).toBeNull()
    expect(errorMessage.value).toBeDefined()
  })
})

describe('analyzeOvertureThemes and partial download failures', () => {
  it('correctly reports fully loaded themes from bundled medford-y preset', () => {
    const medford = OVERTURE_PRESET_CACHES.find((p) => p.name === 'medford-y')!
    const report = analyzeOvertureThemes(medford.payload)

    expect(report.hasPartialFailures).toBe(false)
    expect(report.failedThemes.length).toBe(0)
    expect(report.buildingStatus).toBe('loaded')
    expect(report.buildingCount).toBe(48)
    expect(report.roadStatus).toBe('loaded')
    expect(report.roadCount).toBe(67)
    expect(report.details.place?.status).toBe('loaded')
    expect(report.details.address?.status).toBe('loaded')
  })

  it('distinguishes "no buildings here" (empty query) from "building download failed"', () => {
    // Case A: Legitimate empty area - query ran and found 0 buildings
    const emptyBuildingsPayload = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        bbox: [-71.2, 42.3, -71.1, 42.4],
        centroid: { lon: -71.15, lat: 42.35 },
        counts: {
          segment: 10,
          building: 0
        },
        theme_status: {
          segment: { status: 'success', count: 10 },
          building: { status: 'empty', count: 0 }
        },
        failed_themes: [],
        total_features: 10
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_1',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.2, 42.3], [-71.19, 42.31]] }
        }
      ]
    }

    const emptyReport = analyzeOvertureThemes(emptyBuildingsPayload)
    expect(emptyReport.hasPartialFailures).toBe(false)
    expect(emptyReport.buildingStatus).toBe('empty')
    expect(emptyReport.buildingCount).toBe(0)
    expect(emptyReport.buildingError).toBeUndefined()
    expect(emptyReport.details.building.message).toContain('No buildings here')
    expect(emptyReport.roadStatus).toBe('loaded')
    expect(emptyReport.roadCount).toBe(10)

    // Case B: Building download failed with error
    const failedBuildingsPayload = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        bbox: [-71.2, 42.3, -71.1, 42.4],
        centroid: { lon: -71.15, lat: 42.35 },
        counts: {
          segment: 10,
          building: 0
        },
        theme_status: {
          segment: { status: 'success', count: 10 },
          building: { status: 'failed', error: 'HTTP 504 Gateway Timeout' }
        },
        failed_themes: ['building'],
        errors: {
          building: 'HTTP 504 Gateway Timeout'
        },
        total_features: 10
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_1',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.2, 42.3], [-71.19, 42.31]] }
        }
      ]
    }

    const failedReport = analyzeOvertureThemes(failedBuildingsPayload)
    expect(failedReport.hasPartialFailures).toBe(true)
    expect(failedReport.failedThemes).toContain('building')
    expect(failedReport.buildingStatus).toBe('failed')
    expect(failedReport.buildingCount).toBe(0)
    expect(failedReport.buildingError).toBe('HTTP 504 Gateway Timeout')
    expect(failedReport.details.building.message).toContain('Building download failed')
    expect(failedReport.roadStatus).toBe('loaded')
    expect(failedReport.roadCount).toBe(10)
    expect(failedReport.warnings.some((w) => w.includes('Building download failed'))).toBe(true)
  })

  it('surfaces missing themes when export omits buildings or transportation', () => {
    // GeoJSON with only roads and no mention of buildings in metadata
    const roadsOnlyPayload = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        bbox: [-71.2, 42.3, -71.1, 42.4],
        centroid: { lon: -71.15, lat: 42.35 },
        counts: {
          segment: 5
        },
        total_features: 5
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_1',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.2, 42.3], [-71.19, 42.31]] }
        }
      ]
    }

    const report = analyzeOvertureThemes(roadsOnlyPayload)
    expect(report.hasPartialFailures).toBe(false)
    expect(report.hasMissingThemes).toBe(true)
    expect(report.missingThemes).toContain('building')
    expect(report.buildingStatus).toBe('missing')
    expect(report.roadStatus).toBe('loaded')
    expect(report.warnings.some((w) => w.includes('Buildings theme was not included'))).toBe(true)
  })

  it('surfaces partial download failure when transportation succeeds but places and addresses fail', () => {
    const partialPayload = {
      type: 'FeatureCollection',
      metadata: {
        source: 'Overture Maps Foundation',
        bbox: [-71.2, 42.3, -71.1, 42.4],
        centroid: { lon: -71.15, lat: 42.35 },
        counts: {
          segment: 12,
          building: 4,
          place: 0,
          address: 0
        },
        failed_themes: ['place', 'address'],
        errors: {
          place: 'overturemaps download failed for place: Process terminated',
          address: 'overturemaps download failed for address: Connection reset'
        },
        total_features: 16
      },
      features: [
        {
          type: 'Feature',
          id: 'seg_1',
          overture_type: 'segment',
          geometry: { type: 'LineString', coordinates: [[-71.2, 42.3], [-71.19, 42.31]] }
        },
        {
          type: 'Feature',
          id: 'bldg_1',
          overture_type: 'building',
          geometry: {
            type: 'Polygon',
            coordinates: [[[-71.2, 42.3], [-71.2, 42.31], [-71.19, 42.31], [-71.19, 42.3], [-71.2, 42.3]]]
          }
        }
      ]
    }

    const report = analyzeOvertureThemes(partialPayload)
    expect(report.hasPartialFailures).toBe(true)
    expect(report.failedThemes).toEqual(['place', 'address'])
    expect(report.buildingStatus).toBe('loaded')
    expect(report.roadStatus).toBe('loaded')
    expect(report.warnings.some((w) => w.includes("Theme 'place' download failed"))).toBe(true)
    expect(report.warnings.some((w) => w.includes("Theme 'address' download failed"))).toBe(true)
  })
})
