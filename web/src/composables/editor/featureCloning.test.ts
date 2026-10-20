import { describe, it, expect } from 'bun:test'
import { cloneFeature, cloneProjectEnvelope, cloneFeatureCollection } from './featureCloning'
import type { EditorFeature, ProjectEnvelope } from './types'

describe('featureCloning', () => {
  const sampleFeature: EditorFeature = {
    id: 'road_test_1',
    role: 'road',
    kind: 'road',
    sourceGeometry: {
      type: 'LineString',
      coordinates: [
        [-71.12, 42.41],
        [-71.11, 42.42],
        [-71.10, 42.43]
      ]
    },
    properties: {
      highway: 'residential',
      name: 'Test St'
    },
    roadProfile: {
      carriagewayWidthMeters: { value: 7.0, provenance: 'source' },
      totalCorridorWidthMeters: 7.0,
      strips: [
        {
          id: 'strip_1',
          kind: 'carriageway',
          widthMeters: 7.0,
          offsetMeters: 0
        }
      ]
    }
  }

  it('clones an EditorFeature preserving immutable geometry references without reallocating coordinate arrays', () => {
    const cloned = cloneFeature(sampleFeature)

    // Deep equality of contents
    expect(cloned.id).toBe(sampleFeature.id)
    expect(cloned.properties).toEqual(sampleFeature.properties)
    expect(cloned.roadProfile).toEqual(sampleFeature.roadProfile)

    // But properties and roadProfile are separate objects (mutating clone does not mutate original)
    cloned.properties.name = 'Renamed St'
    expect(sampleFeature.properties.name).toBe('Test St')

    // Immutable coordinate arrays are reused directly, avoiding expensive deep copies
    expect(cloned.sourceGeometry).toBe(sampleFeature.sourceGeometry)
    expect(cloned.sourceGeometry.coordinates).toBe(sampleFeature.sourceGeometry.coordinates)
  })

  it('clones project envelope features while preserving immutable coordinate arrays', () => {
    const envelope: ProjectEnvelope = {
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'osm' },
      projectionOrigin: { lon: -71.11, lat: 42.42 },
      sourceFeatures: [sampleFeature],
      features: [sampleFeature],
      editOverrides: {}
    }

    const clonedEnv = cloneProjectEnvelope(envelope)

    expect(clonedEnv.features.length).toBe(1)
    expect(clonedEnv.features[0].id).toBe(sampleFeature.id)
    expect(clonedEnv.features[0].sourceGeometry).toBe(sampleFeature.sourceGeometry)

    // Ensure modifying features array or properties does not mutate original
    clonedEnv.features[0].properties.name = 'Changed St'
    expect(envelope.features[0].properties.name).toBe('Test St')
  })
})
