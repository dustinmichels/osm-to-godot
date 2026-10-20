import { describe, it, expect } from 'bun:test'
import {
  calculateBBoxAreaKm2,
  validateBoundingBox,
  assertValidBoundingBox,
  sanitizeRelease,
  getOvertureThemeUrl,
  buildThemeQuery,
  MAX_BBOX_AREA_KM2
} from './queries'

describe('DuckDB Parameterized Queries', () => {
  const sampleBBox: [number, number, number, number] = [-71.06, 42.35, -71.05, 42.36]

  it('calculates bounding box area in km²', () => {
    const area = calculateBBoxAreaKm2(sampleBBox)
    expect(area).toBeGreaterThan(0.5)
    expect(area).toBeLessThan(2.0)
  })

  it('validates normal bounding box successfully', () => {
    const res = validateBoundingBox(sampleBBox)
    expect(res.valid).toBe(true)
    expect(res.areaKm2).toBeGreaterThan(0)
    expect(res.error).toBeUndefined()
  })

  it('validates object format { west, south, east, north }', () => {
    const res = validateBoundingBox({
      west: -71.06,
      south: 42.35,
      east: -71.05,
      north: 42.36
    })
    expect(res.valid).toBe(true)
    expect(res.bbox).toEqual(sampleBBox)
  })

  it('rejects invalid latitude and longitude ranges', () => {
    expect(validateBoundingBox([-71.06, 45, -71.05, 42]).valid).toBe(false) // south >= north
    expect(validateBoundingBox([-71.05, 42, -71.06, 43]).valid).toBe(false) // west >= east
    expect(validateBoundingBox([-71.06, -95, -71.05, 42]).valid).toBe(false) // south < -90
    expect(validateBoundingBox([-190, 42, -71.05, 43]).valid).toBe(false) // west < -180
    expect(validateBoundingBox([NaN, 42, -71.05, 43]).valid).toBe(false) // non-finite
  })

  it('rejects bounding boxes exceeding maxAreaKm2 limit (5.0 km²)', () => {
    // 1 degree by 1 degree box is ~10,000 km²
    const largeBBox: [number, number, number, number] = [-72.0, 42.0, -71.0, 43.0]
    const res = validateBoundingBox(largeBBox, MAX_BBOX_AREA_KM2)
    expect(res.valid).toBe(false)
    expect(res.error).toContain('exceeds safety limit')

    expect(() => assertValidBoundingBox(largeBBox, MAX_BBOX_AREA_KM2)).toThrow(
      'exceeds safety limit'
    )
  })

  it('sanitizes and validates release strings', () => {
    expect(sanitizeRelease('2024-11-13.0')).toBe('2024-11-13.0')
    expect(sanitizeRelease('2025-01-22')).toBe('2025-01-22')
    expect(sanitizeRelease()).toBe('2024-11-13.0')

    expect(() => sanitizeRelease('2024; DROP TABLE users;')).toThrow('Invalid Overture release format')
    expect(() => sanitizeRelease('invalid-release')).toThrow('Invalid Overture release format')
  })

  it('builds buildings query with pushdown, height, num_floors, level, class, names, source_dataset', () => {
    const query = buildThemeQuery('buildings', sampleBBox, '2024-11-13.0')
    expect(query.theme).toBe('buildings')
    expect(query.overtureType).toBe('building')
    expect(query.parquetUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=buildings/type=building/*'
    )
    expect(query.sql).toContain('ST_AsGeoJSON(geometry) AS geometry')
    expect(query.sql).toContain('height')
    expect(query.sql).toContain('num_floors')
    expect(query.sql).toContain('level')
    expect(query.sql).toContain('class')
    expect(query.sql).toContain('names')
    expect(query.sql).toContain('source_dataset')
    expect(query.sql).toContain('bbox.xmin <= -71.05')
    expect(query.sql).toContain('bbox.xmax >= -71.06')
    expect(query.sql).toContain('bbox.ymin <= 42.36')
    expect(query.sql).toContain('bbox.ymax >= 42.35')
  })

  it('builds transportation query with pushdown, subtype, class, subclass, names, level, access_restrictions, speed_limits', () => {
    const query = buildThemeQuery('transportation', sampleBBox, '2024-11-13.0')
    expect(query.theme).toBe('transportation')
    expect(query.overtureType).toBe('segment')
    expect(query.parquetUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=transportation/type=segment/*'
    )
    expect(query.sql).toContain('ST_AsGeoJSON(geometry) AS geometry')
    expect(query.sql).toContain('subtype')
    expect(query.sql).toContain('class')
    expect(query.sql).toContain('subclass')
    expect(query.sql).toContain('names')
    expect(query.sql).toContain('level')
    expect(query.sql).toContain('access_restrictions')
    expect(query.sql).toContain('speed_limits')
    expect(query.sql).toContain('bbox.xmin <= -71.05')
  })

  it('builds places query with pushdown, names, categories, brand', () => {
    const query = buildThemeQuery('places', sampleBBox, '2024-11-13.0')
    expect(query.theme).toBe('places')
    expect(query.overtureType).toBe('place')
    expect(query.parquetUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=places/type=place/*'
    )
    expect(query.sql).toContain('ST_AsGeoJSON(geometry) AS geometry')
    expect(query.sql).toContain('names')
    expect(query.sql).toContain('categories')
    expect(query.sql).toContain('brand')
    expect(query.sql).toContain('bbox.xmin <= -71.05')
  })

  it('builds addresses query with pushdown, street, house number', () => {
    const query = buildThemeQuery('addresses', sampleBBox, '2024-11-13.0')
    expect(query.theme).toBe('addresses')
    expect(query.overtureType).toBe('address')
    expect(query.parquetUrl).toBe(
      'https://overturemaps-us-west-2.s3.amazonaws.com/release/2024-11-13.0/theme=addresses/type=address/*'
    )
    expect(query.sql).toContain('ST_AsGeoJSON(geometry) AS geometry')
    expect(query.sql).toContain('street')
    expect(query.sql).toContain('house_number')
    expect(query.sql).toContain('number')
    expect(query.sql).toContain('bbox.xmin <= -71.05')
  })
})
