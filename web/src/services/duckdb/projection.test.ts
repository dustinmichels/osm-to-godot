import { describe, it, expect } from 'bun:test'
import * as arrow from 'apache-arrow'
import { projectRecordBatchToGeoJSON, projectArrowTableToGeoJSON } from './projection'

describe('DuckDB Arrow to GeoJSON Projection', () => {
  it('projects Arrow RecordBatch with geometry, id, and typed properties', () => {
    const idVec = arrow.vectorFromArray(['bldg_1', 'bldg_2'])
    const geomVec = arrow.vectorFromArray([
      JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }),
      JSON.stringify({ type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] })
    ])
    const heightVec = arrow.vectorFromArray([12.5, 25.0])
    const floorsVec = arrow.vectorFromArray([BigInt(3), BigInt(6)])
    const namesVec = arrow.vectorFromArray([
      JSON.stringify({ primary: 'Market Tower', common: 'Tower' }),
      null
    ])

    const batch = new arrow.RecordBatch({
      id: idVec,
      geometry: geomVec,
      height: heightVec,
      num_floors: floorsVec,
      names: namesVec
    })

    const features = projectRecordBatchToGeoJSON(batch, 'building')
    expect(features.length).toBe(2)

    const f1 = features[0]
    expect(f1.id).toBe('bldg_1')
    expect(f1.overture_type).toBe('building')
    expect(f1.geometry?.type).toBe('Polygon')
    expect(f1.properties.height).toBe(12.5)
    expect(f1.properties.num_floors).toBe(3) // BigInt converted to number
    expect(f1.properties.names).toEqual({ primary: 'Market Tower', common: 'Tower' })
    expect(f1.properties.overture_type).toBe('building')

    const f2 = features[1]
    expect(f2.id).toBe('bldg_2')
    expect(f2.properties.height).toBe(25.0)
    expect(f2.properties.num_floors).toBe(6)
    expect(f2.properties.names).toBeUndefined()
  })

  it('handles geometry_json and geom column aliases and missing id', () => {
    const geomVec = arrow.vectorFromArray([
      JSON.stringify({ type: 'Point', coordinates: [-122.4, 37.7] })
    ])
    const catVec = arrow.vectorFromArray([JSON.stringify({ main: 'restaurant' })])

    const batch = new arrow.RecordBatch({
      geom: geomVec,
      categories: catVec
    })

    const features = projectRecordBatchToGeoJSON(batch, 'place')
    expect(features.length).toBe(1)
    expect(features[0].id).toBe('place_0')
    expect(features[0].geometry?.type).toBe('Point')
    expect(features[0].properties.categories).toEqual({ main: 'restaurant' })
  })

  it('handles invalid geometry JSON gracefully without throwing', () => {
    const idVec = arrow.vectorFromArray(['err_1'])
    const geomVec = arrow.vectorFromArray(['not-valid-json'])

    const batch = new arrow.RecordBatch({
      id: idVec,
      geometry: geomVec
    })

    const features = projectRecordBatchToGeoJSON(batch, 'segment')
    expect(features.length).toBe(1)
    expect(features[0].id).toBe('err_1')
    expect(features[0].geometry).toBeNull()
  })

  it('projects full Arrow Table with multiple rows', () => {
    const table = arrow.tableFromArrays({
      id: ['1', '2'],
      geometry: [
        JSON.stringify({ type: 'Point', coordinates: [0, 0] }),
        JSON.stringify({ type: 'Point', coordinates: [1, 1] })
      ]
    })

    const features = projectArrowTableToGeoJSON(table, 'point')
    expect(features.length).toBe(2)
    expect(features[0].id).toBe('1')
    expect(features[1].id).toBe('2')
  })
})
