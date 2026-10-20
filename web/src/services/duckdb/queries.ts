import type { BoundingBoxInput, BoundingBoxTuple, OvertureTheme } from './types'
import { OVERTURE_S3_BASE_URL, DEFAULT_OVERTURE_RELEASE } from './duckdbEngine'

export const MAX_BBOX_AREA_KM2 = 5.0
const SAFE_RELEASE_REGEX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$/

export interface BBoxValidationResult {
  valid: boolean
  error?: string
  areaKm2: number
  bbox: BoundingBoxTuple
}

export interface ThemeQueryDefinition {
  theme: OvertureTheme
  overtureType: string
  parquetUrl: string
  sql: string
}

/**
 * Calculates approximate area in km² for a given [west, south, east, north] bounding box.
 */
export function calculateBBoxAreaKm2(bbox: BoundingBoxTuple): number {
  const [west, south, east, north] = bbox
  const latMid = ((south + north) / 2) * (Math.PI / 180)
  const mPerDegLat = 111320
  const mPerDegLon = 111320 * Math.cos(latMid)
  const widthKm = Math.abs((east - west) * mPerDegLon) / 1000
  const heightKm = Math.abs((north - south) * mPerDegLat) / 1000
  return widthKm * heightKm
}

/**
 * Validates bounding box coordinates and enforces geographic and memory safety limits.
 */
export function validateBoundingBox(
  input: BoundingBoxInput,
  maxAreaKm2: number = MAX_BBOX_AREA_KM2
): BBoxValidationResult {
  const bbox: BoundingBoxTuple = Array.isArray(input)
    ? [input[0], input[1], input[2], input[3]]
    : [input.west, input.south, input.east, input.north]

  const [west, south, east, north] = bbox

  if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
    return { valid: false, error: 'Bounding box coordinates must be finite numbers', areaKm2: 0, bbox }
  }

  if (south < -90 || north > 90 || south >= north) {
    return {
      valid: false,
      error: `Invalid latitude range: south (${south}) must be less than north (${north}) within [-90, 90]`,
      areaKm2: 0,
      bbox
    }
  }

  if (west < -180 || east > 180 || west >= east) {
    return {
      valid: false,
      error: `Invalid longitude range: west (${west}) must be less than east (${east}) within [-180, 180]`,
      areaKm2: 0,
      bbox
    }
  }

  const areaKm2 = calculateBBoxAreaKm2(bbox)
  if (areaKm2 > maxAreaKm2) {
    return {
      valid: false,
      error: `Bounding box area (${areaKm2.toFixed(2)} km²) exceeds safety limit of ${maxAreaKm2} km²`,
      areaKm2,
      bbox
    }
  }

  return { valid: true, areaKm2, bbox }
}

/**
 * Asserts bounding box validity, throwing an error if invalid or exceeding maximum allowed area.
 */
export function assertValidBoundingBox(
  input: BoundingBoxInput,
  maxAreaKm2: number = MAX_BBOX_AREA_KM2
): BoundingBoxTuple {
  const result = validateBoundingBox(input, maxAreaKm2)
  if (!result.valid) {
    throw new Error(result.error ?? 'Invalid bounding box')
  }
  return result.bbox
}

/**
 * Sanitizes or validates release version string.
 */
export function sanitizeRelease(release?: string): string {
  if (!release) return DEFAULT_OVERTURE_RELEASE
  const trimmed = release.trim()
  if (!SAFE_RELEASE_REGEX.test(trimmed)) {
    throw new Error(`Invalid Overture release format: "${release}". Expected format YYYY-MM-DD or YYYY-MM-DD.N`)
  }
  return trimmed
}

/**
 * Returns Overture Parquet Hive partition path for a given theme.
 */
export function getOvertureThemeUrl(
  theme: OvertureTheme,
  release: string = DEFAULT_OVERTURE_RELEASE,
  baseUrl: string = OVERTURE_S3_BASE_URL
): string {
  switch (theme) {
    case 'buildings':
      return `${baseUrl}/${release}/theme=buildings/type=building/*`
    case 'transportation':
      return `${baseUrl}/${release}/theme=transportation/type=segment/*`
    case 'places':
      return `${baseUrl}/${release}/theme=places/type=place/*`
    case 'addresses':
      return `${baseUrl}/${release}/theme=addresses/type=address/*`
  }
}

/**
 * Builds parameterized SQL queries for Overture themes with Parquet metadata bounding box pushdown.
 */
export function buildThemeQuery(
  theme: OvertureTheme,
  bboxInput: BoundingBoxInput,
  releaseInput?: string,
  options?: { maxAreaKm2?: number; baseUrl?: string }
): ThemeQueryDefinition {
  const bbox = assertValidBoundingBox(bboxInput, options?.maxAreaKm2)
  const release = sanitizeRelease(releaseInput)
  const baseUrl = options?.baseUrl ?? OVERTURE_S3_BASE_URL
  const [west, south, east, north] = bbox
  const parquetUrl = getOvertureThemeUrl(theme, release, baseUrl)
  const pushdown = `bbox.xmin <= ${east} AND bbox.xmax >= ${west} AND bbox.ymin <= ${north} AND bbox.ymax >= ${south}`

  switch (theme) {
    case 'buildings': {
      const parquetUrl = `${baseUrl}/${release}/theme=buildings/type=building/*`
      const sql = `
        SELECT
          id,
          ST_AsGeoJSON(geometry) AS geometry,
          height,
          num_floors,
          level,
          class,
          names,
          CASE WHEN sources IS NOT NULL AND len(sources) > 0 THEN sources[1].dataset ELSE NULL END AS source_dataset,
          sources
        FROM read_parquet('${parquetUrl}')
        WHERE ${pushdown}
      `
      return { theme, overtureType: 'building', parquetUrl, sql }
    }

    case 'transportation': {
      const parquetUrl = `${baseUrl}/${release}/theme=transportation/type=segment/*`
      const sql = `
        SELECT
          id,
          ST_AsGeoJSON(geometry) AS geometry,
          subtype,
          class,
          subclass,
          names,
          level,
          access_restrictions,
          speed_limits,
          sources
        FROM read_parquet('${parquetUrl}')
        WHERE ${pushdown}
      `
      return { theme, overtureType: 'segment', parquetUrl, sql }
    }

    case 'places': {
      const parquetUrl = `${baseUrl}/${release}/theme=places/type=place/*`
      const sql = `
        SELECT
          id,
          ST_AsGeoJSON(geometry) AS geometry,
          names,
          categories,
          brand,
          sources
        FROM read_parquet('${parquetUrl}')
        WHERE ${pushdown}
      `
      return { theme, overtureType: 'place', parquetUrl, sql }
    }

    case 'addresses': {
      const parquetUrl = `${baseUrl}/${release}/theme=addresses/type=address/*`
      const sql = `
        SELECT
          id,
          ST_AsGeoJSON(geometry) AS geometry,
          street,
          number AS house_number,
          number,
          unit,
          postcode,
          sources
        FROM read_parquet('${parquetUrl}')
        WHERE ${pushdown}
      `
      return { theme, overtureType: 'address', parquetUrl, sql }
    }
  }
}
