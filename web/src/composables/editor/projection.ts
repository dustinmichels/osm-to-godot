/**
 * Local metric projection utilities.
 * Uses transverse Mercator or local equirectangular approximation around an origin point.
 * Never buffers degrees directly; all offsets are strictly computed in meters.
 */

// Earth radius in meters (WGS84 authalic / mean radius), matching Godot OSMProjection.EARTH_RADIUS
export const EARTH_RADIUS_METERS = 6378137.0

/**
 * Supported geographic and scale bounds for the local tangent plane / equirectangular projection.
 *
 * Projection distortion in equirectangular projection grows with sec(latitude) and distance from origin:
 * - Beyond +/- 75 degrees latitude, distortion exceeds acceptable limits (cos(75) ~ 0.259).
 * - Above 10 km² area or ~5 km distance from origin, curvature error exceeds typical street-scale tolerance.
 */
export const PROJECTION_LIMITS = {
  /** Maximum recommended latitude magnitude (+/- degrees) */
  MAX_RECOMMENDED_LATITUDE: 75.0,
  /** Absolute hard limit latitude magnitude (+/- degrees) before polar singularity */
  MAX_LATITUDE: 85.0,
  /** Warning threshold for area in square kilometers */
  AREA_WARNING_KM2: 2.5,
  /** Limit threshold for area in square kilometers */
  AREA_LIMIT_KM2: 10.0,
  /** Distance from projection origin in meters before local distortion warning */
  MAX_DISTANCE_FROM_ORIGIN_METERS: 10000.0
} as const

export interface Point2D {
  x: number // meters East of origin (+X = East in Godot)
  y: number // meters North of origin (+Y in 2D tangent plane; corresponds to -Z in Godot 3D space)
}

/**
 * 3D point in Godot coordinate space:
 * +X = East (meters)
 * +Y = Up / Elevation (meters)
 * -Z = North (meters)
 * 1.0 unit = 1.0 meter
 */
export interface GodotVector3 {
  x: number
  y: number
  z: number
}

export interface LonLat {
  lon: number
  lat: number
}

export interface ProjectionWarning {
  code: 'extreme_latitude' | 'unsupported_latitude' | 'excessive_area' | 'extreme_distance_from_origin' | 'invalid_origin'
  message: string
  level: 'warning' | 'error'
}
/**
 * Projects a [longitude, latitude] pair in degrees to local metric coordinates [x, y] in meters
 * relative to the given origin [originLon, originLat].
 */
export function projectToLocalMeters(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number
): Point2D {
  const originLatRad = (originLat * Math.PI) / 180.0
  const dLonRad = ((lon - originLon) * Math.PI) / 180.0
  const dLatRad = ((lat - originLat) * Math.PI) / 180.0

  const x = dLonRad * Math.cos(originLatRad) * EARTH_RADIUS_METERS
  const y = dLatRad * EARTH_RADIUS_METERS

  return { x, y }
}

/**
 * Projects a [longitude, latitude] pair in degrees to Godot 3D space:
 * +X = East, +Y = Up (meters), -Z = North.
 * Matches OSMProjection.project() in Godot:
 * x = EARTH_RADIUS * d_lon_rad * cos_lat0
 * z = -EARTH_RADIUS * d_lat_rad
 */
export function projectToGodot3D(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number,
  elevation = 0.0
): GodotVector3 {
  const originLatRad = (originLat * Math.PI) / 180.0
  const dLonRad = ((lon - originLon) * Math.PI) / 180.0
  const dLatRad = ((lat - originLat) * Math.PI) / 180.0

  const x = dLonRad * Math.cos(originLatRad) * EARTH_RADIUS_METERS
  const z = -dLatRad * EARTH_RADIUS_METERS

  return { x, y: elevation, z }
}

/**
 * Inverts Godot 3D coordinates (x = East, y = Up, z = -North) back to WGS84 [longitude, latitude] degrees.
 * Matches OSMProjection.unproject() in Godot.
 */
export function unprojectFromGodot3D(
  pos: { x: number; y?: number; z: number },
  originLon: number,
  originLat: number
): LonLat {
  const originLatRad = (originLat * Math.PI) / 180.0
  const cosLat0 = Math.cos(originLatRad)

  const dLatRad = -pos.z / EARTH_RADIUS_METERS
  const dLonRad = Math.abs(cosLat0) > 1e-12 ? pos.x / (EARTH_RADIUS_METERS * cosLat0) : 0.0

  const lat = originLat + (dLatRad * 180.0) / Math.PI
  const lon = originLon + (dLonRad * 180.0) / Math.PI

  return { lon, lat }
}

/**
 * Evaluates projection suitability and returns warnings or errors if origin, bounds,
 * or latitude exceed supported metric limits.
 */
export function validateProjectionLimits(params: {
  origin: { lon: number; lat: number }
  bounds?: [number, number, number, number] // [minLon, minLat, maxLon, maxLat]
  areaKm2?: number
}): ProjectionWarning[] {
  const warnings: ProjectionWarning[] = []
  const { origin, bounds, areaKm2 } = params

  if (
    !Number.isFinite(origin.lat) ||
    !Number.isFinite(origin.lon) ||
    origin.lat < -90 ||
    origin.lat > 90 ||
    origin.lon < -180 ||
    origin.lon > 180
  ) {
    warnings.push({
      code: 'invalid_origin',
      message: `Invalid projection origin: [${origin.lon}, ${origin.lat}]. Coordinates must be finite WGS84 degrees.`,
      level: 'error'
    })
    return warnings
  }

  const absOriginLat = Math.abs(origin.lat)
  if (absOriginLat > PROJECTION_LIMITS.MAX_LATITUDE) {
    warnings.push({
      code: 'unsupported_latitude',
      message: `Origin latitude ${origin.lat.toFixed(2)}° exceeds maximum supported latitude of ±${PROJECTION_LIMITS.MAX_LATITUDE}°. Equirectangular metric distortion is severe near poles.`,
      level: 'error'
    })
  } else if (absOriginLat > PROJECTION_LIMITS.MAX_RECOMMENDED_LATITUDE) {
    warnings.push({
      code: 'extreme_latitude',
      message: `Origin latitude ${origin.lat.toFixed(2)}° exceeds recommended latitude limit of ±${PROJECTION_LIMITS.MAX_RECOMMENDED_LATITUDE}°. Local horizontal scale will exhibit noticeable distortion.`,
      level: 'warning'
    })
  }

  if (bounds) {
    const [minLon, minLat, maxLon, maxLat] = bounds
    const maxBoundLat = Math.max(Math.abs(minLat), Math.abs(maxLat))
    if (maxBoundLat > PROJECTION_LIMITS.MAX_LATITUDE && absOriginLat <= PROJECTION_LIMITS.MAX_LATITUDE) {
      warnings.push({
        code: 'unsupported_latitude',
        message: `Selection bounds reach latitude ${maxBoundLat.toFixed(2)}°, exceeding supported limit of ±${PROJECTION_LIMITS.MAX_LATITUDE}°.`,
        level: 'error'
      })
    } else if (
      maxBoundLat > PROJECTION_LIMITS.MAX_RECOMMENDED_LATITUDE &&
      absOriginLat <= PROJECTION_LIMITS.MAX_RECOMMENDED_LATITUDE
    ) {
      warnings.push({
        code: 'extreme_latitude',
        message: `Selection bounds reach latitude ${maxBoundLat.toFixed(2)}°, exceeding recommended limit of ±${PROJECTION_LIMITS.MAX_RECOMMENDED_LATITUDE}°.`,
        level: 'warning'
      })
    }

    // Check distance of bounds corners from origin
    const corners = [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat]
    ]
    for (const [cLon, cLat] of corners) {
      const p = projectToLocalMeters(cLon, cLat, origin.lon, origin.lat)
      const dist = Math.hypot(p.x, p.y)
      if (dist > PROJECTION_LIMITS.MAX_DISTANCE_FROM_ORIGIN_METERS) {
        warnings.push({
          code: 'extreme_distance_from_origin',
          message: `Area extends ${(dist / 1000).toFixed(1)} km from projection origin, exceeding recommended ${(PROJECTION_LIMITS.MAX_DISTANCE_FROM_ORIGIN_METERS / 1000).toFixed(0)} km local tangent radius. Curvature and metric offset error increase with distance.`,
          level: 'warning'
        })
        break
      }
    }
  }

  if (areaKm2 !== undefined && areaKm2 > PROJECTION_LIMITS.AREA_LIMIT_KM2) {
    warnings.push({
      code: 'excessive_area',
      message: `Selected area (${areaKm2.toFixed(1)} km²) exceeds supported limit of ${PROJECTION_LIMITS.AREA_LIMIT_KM2} km².`,
      level: 'warning'
    })
  }

  return warnings
}
/**
 * Inverts local metric coordinates [x, y] back to [longitude, latitude] in degrees.
 */
export function unprojectFromLocalMeters(
  x: number,
  y: number,
  originLon: number,
  originLat: number
): LonLat {
  const originLatRad = (originLat * Math.PI) / 180.0

  const dLonRad = x / (Math.cos(originLatRad) * EARTH_RADIUS_METERS)
  const dLatRad = y / EARTH_RADIUS_METERS

  const lon = originLon + (dLonRad * 180.0) / Math.PI
  const lat = originLat + (dLatRad * 180.0) / Math.PI

  return { lon, lat }
}

/**
 * Projects an array of GeoJSON [lon, lat] coordinates to local metric Point2D (meters).
 */
export function projectCoordinatesToLocalMeters(
  coords: number[][],
  origin: { lon: number; lat: number }
): Point2D[] {
  return coords.map(([lon, lat]) => projectToLocalMeters(lon, lat, origin.lon, origin.lat))
}

/**
 * Unprojects an array of local metric Point2D (meters) back to GeoJSON [lon, lat] coordinates in degrees.
 */
export function unprojectCoordinatesFromLocalMeters(
  points: Point2D[],
  origin: { lon: number; lat: number },
  precision = 7
): [number, number][] {
  return points.map((pt) => {
    const ll = unprojectFromLocalMeters(pt.x, pt.y, origin.lon, origin.lat)
    return [Number(ll.lon.toFixed(precision)), Number(ll.lat.toFixed(precision))]
  })
}

/**
 * Computes polyline length in meters in local metric space.
 */
export function computeLocalMetricLength(
  coords: number[][],
  origin: { lon: number; lat: number }
): number {
  if (!coords || coords.length < 2) return 0
  const points = projectCoordinatesToLocalMeters(coords, origin)
  let length = 0
  for (let i = 0; i < points.length - 1; i++) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y)
  }
  return length
}

/**
 * Computes polygon ring area in square meters in local metric space using the shoelace formula.
 */
export function computeLocalMetricArea(
  ringCoords: number[][],
  origin: { lon: number; lat: number }
): number {
  if (!ringCoords || ringCoords.length < 3) return 0
  const points = projectCoordinatesToLocalMeters(ringCoords, origin)
  let sum = 0
  for (let i = 0; i < points.length - 1; i++) {
    sum += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y
  }
  return Math.abs(sum) / 2
}

/**
 * Computes the 2D bounding box [minLon, minLat, maxLon, maxLat] enclosing all feature geometries.
 */
export function computeProjectBounds(
  features: Array<{ effectiveGeometry?: GeoJSON.Geometry; sourceGeometry?: GeoJSON.Geometry }>
): [number, number, number, number] | null {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity

  function visitCoords(coords: unknown): void {
    if (!Array.isArray(coords) || coords.length === 0) return
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [lon, lat] = coords as [number, number]
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
    } else {
      for (const item of coords) {
        visitCoords(item)
      }
    }
  }

  for (const f of features) {
    const geom = f.effectiveGeometry || f.sourceGeometry
    if (geom && typeof geom === 'object' && 'coordinates' in geom) {
      visitCoords(geom.coordinates)
    }
  }

  if (!isFinite(minLon) || !isFinite(minLat) || !isFinite(maxLon) || !isFinite(maxLat)) {
    return null
  }
  return [minLon, minLat, maxLon, maxLat]
}
