import type * as arrow from 'apache-arrow'
import type { RawGeoJSONFeature } from './types'

/**
 * Projects an Apache Arrow RecordBatch into an array of lightweight GeoJSON features.
 * Maps columns to properties, parses ST_AsGeoJSON geometry strings, and ensures
 * BigInts and complex nested structures (names, categories, etc.) are safely converted.
 */
export function projectRecordBatchToGeoJSON(
  batch: arrow.RecordBatch,
  overtureType: string
): RawGeoJSONFeature[] {
  const numRows = batch.numRows
  if (numRows === 0) return []

  const fields = batch.schema.fields
  const idCol = batch.getChild('id')
  const geomCol = batch.getChild('geometry') ?? batch.getChild('geometry_json') ?? batch.getChild('geom')

  const features: RawGeoJSONFeature[] = new Array(numRows)

  for (let i = 0; i < numRows; i++) {
    // 1. Extract feature ID
    const rawId = idCol ? idCol.get(i) : undefined
    const id = rawId !== null && rawId !== undefined ? String(rawId) : `${overtureType}_${i}`

    // 2. Extract and parse geometry
    let geometry: RawGeoJSONFeature['geometry'] = null
    if (geomCol) {
      const rawGeom = geomCol.get(i)
      if (typeof rawGeom === 'string' && rawGeom.length > 0) {
        try {
          geometry = JSON.parse(rawGeom)
        } catch {
          geometry = null
        }
      } else if (rawGeom && typeof rawGeom === 'object' && 'type' in (rawGeom as object)) {
        geometry = rawGeom as RawGeoJSONFeature['geometry']
      }
    }

    // 3. Extract and project properties
    const properties: Record<string, unknown> = {
      overture_type: overtureType
    }

    for (let f = 0; f < fields.length; f++) {
      const fieldName = fields[f].name
      if (
        fieldName === 'id' ||
        fieldName === 'geometry' ||
        fieldName === 'geometry_json' ||
        fieldName === 'geom'
      ) {
        continue
      }

      const col = batch.getChildAt(f)
      if (!col) continue
      const rawVal = col.get(i)
      if (rawVal === null || rawVal === undefined) {
        continue
      }

      // Handle BigInt serialization
      if (typeof rawVal === 'bigint') {
        properties[fieldName] = Number(rawVal)
      } else if (typeof rawVal === 'string' && (rawVal.startsWith('{') || rawVal.startsWith('['))) {
        try {
          properties[fieldName] = JSON.parse(rawVal)
        } catch {
          properties[fieldName] = rawVal
        }
      } else {
        properties[fieldName] = rawVal
      }
    }

    features[i] = {
      type: 'Feature',
      id,
      overture_type: overtureType,
      geometry,
      properties
    }
  }

  return features
}

/**
 * Projects an entire Apache Arrow Table into an array of lightweight GeoJSON features.
 */
export function projectArrowTableToGeoJSON(
  table: arrow.Table,
  overtureType: string
): RawGeoJSONFeature[] {
  const result: RawGeoJSONFeature[] = []
  for (const batch of table.batches) {
    const features = projectRecordBatchToGeoJSON(batch, overtureType)
    for (let i = 0; i < features.length; i++) {
      result.push(features[i])
    }
  }
  return result
}
