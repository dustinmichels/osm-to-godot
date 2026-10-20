import { EditorFeature, GeometryDetails, BlockingGeometryError, mapKindToCategory } from './types'
import { isValidCoordinate } from './validation'

/**
 * Appends a warning message to an EditorFeature's warnings list, ensuring deduplication.
 */
export function addFeatureWarning(feature: EditorFeature, warning: string): void {
  if (!feature.warnings) {
    feature.warnings = []
  }
  if (!feature.warnings.includes(warning)) {
    feature.warnings.push(warning)
  }
}

/**
 * Appends a profile flag to a road feature's roadProfile, ensuring deduplication.
 */
export function addFeatureProfileFlag(feature: EditorFeature, flag: string): void {
  if (!feature.roadProfile) return
  if (!feature.roadProfile.profileFlags) {
    feature.roadProfile.profileFlags = []
  }
  if (!feature.roadProfile.profileFlags.includes(flag)) {
    feature.roadProfile.profileFlags.push(flag)
  }
}

/**
 * Checks whether a warning message describes a geometry, coordinate, offset, or clipping issue.
 */
export function isGeometryWarning(warning: string): boolean {
  return /geometry|polygon|ribbon|clipped|degenerate|unclosed|self-intersect|coordinate|width|trim|miter|boundary/i.test(
    warning
  )
}

/**
 * Returns all geometry-related warnings associated with a feature.
 */
export function getFeatureGeometryWarnings(feature: EditorFeature | null): string[] {
  if (!feature || !feature.warnings) return []
  return feature.warnings.filter(isGeometryWarning)
}

/**
 * Validates the basic structural integrity of a feature's geometry (source or effective)
 * without mutating it. Returns any discovered warnings.
 */
export function validateFeatureGeometryStructure(feature: EditorFeature): {
  valid: boolean
  warnings: string[]
} {
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  const warnings: string[] = []

  if (!geom) {
    warnings.push(`Feature ${feature.id} is missing geometry. Inspectable source data preserved.`)
    return { valid: false, warnings }
  }

  if (geom.type === 'LineString') {
    const coords = geom.coordinates
    if (!Array.isArray(coords) || coords.length < 2) {
      warnings.push(`Feature ${feature.id} has fewer than 2 coordinates. Preserving source geometry.`)
    } else {
      for (let i = 0; i < coords.length; i++) {
        const pt = coords[i]
        if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
          warnings.push(`Feature ${feature.id} coordinate #${i} is non-finite or invalid. Preserving source geometry.`)
          break
        }
      }
    }
  } else if (geom.type === 'Polygon') {
    const rings = geom.coordinates
    if (!Array.isArray(rings) || rings.length === 0 || rings[0].length < 4) {
      warnings.push(`Feature ${feature.id} outer polygon ring has fewer than 4 coordinates. Preserving source geometry.`)
    } else {
      const outer = rings[0]
      const first = outer[0]
      const last = outer[outer.length - 1]
      if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
        warnings.push(`Feature ${feature.id} outer polygon ring is not closed. Preserving source geometry.`)
      }
      for (let i = 0; i < outer.length; i++) {
        const pt = outer[i]
        if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
          warnings.push(`Feature ${feature.id} outer ring coordinate #${i} is non-finite. Preserving source geometry.`)
          break
        }
      }
    }
  }

  return {
    valid: warnings.length === 0,
    warnings
  }
}

/**
 * Inspects a feature's geometry for blocking defects that prevent scene generation or 3D extrusion.
 * Returns an array of blocking errors (empty if valid).
 */
export function findFeatureBlockingGeometryErrors(feature: EditorFeature): BlockingGeometryError[] {
  const errors: BlockingGeometryError[] = []
  const geom = feature.effectiveGeometry || feature.sourceGeometry
  const role = feature.role ?? feature.kind

  if (!geom) {
    errors.push({
      featureId: feature.id,
      role,
      kind: feature.kind,
      message: `Feature "${feature.id}" is missing geometry data.`
    })
    return errors
  }

  const geomType = geom.type

  if (geomType === 'LineString') {
    const coords = (geom as GeoJSON.LineString).coordinates
    if (!Array.isArray(coords) || coords.length < 2) {
      errors.push({
        featureId: feature.id,
        role,
        kind: feature.kind,
        geometryType: 'LineString',
        message: `LineString requires at least 2 coordinate points (${Array.isArray(coords) ? coords.length : 0} found).`
      })
    } else {
      let hasInvalidCoord = false
      let allIdentical = true
      const first = coords[0]
      for (let i = 0; i < coords.length; i++) {
        const pt = coords[i]
        if (!Array.isArray(pt) || pt.length < 2 || !isValidCoordinate(pt[0], pt[1])) {
          errors.push({
            featureId: feature.id,
            role,
            kind: feature.kind,
            geometryType: 'LineString',
            message: `Coordinate #${i} is non-finite, invalid, or out of spherical bounds.`
          })
          hasInvalidCoord = true
          break
        }
        if (i > 0 && (pt[0] !== first[0] || pt[1] !== first[1])) {
          allIdentical = false
        }
      }
      if (!hasInvalidCoord && allIdentical && coords.length >= 2) {
        errors.push({
          featureId: feature.id,
          role,
          kind: feature.kind,
          geometryType: 'LineString',
          message: 'LineString has zero length (all coordinates are identical).'
        })
      }
    }
  } else if (geomType === 'Polygon') {
    const rings = (geom as GeoJSON.Polygon).coordinates
    if (!Array.isArray(rings) || rings.length === 0) {
      errors.push({
        featureId: feature.id,
        role,
        kind: feature.kind,
        geometryType: 'Polygon',
        message: 'Polygon has no linear rings.'
      })
    } else {
      const outer = rings[0]
      if (!Array.isArray(outer) || outer.length < 4) {
        errors.push({
          featureId: feature.id,
          role,
          kind: feature.kind,
          geometryType: 'Polygon',
          message: `Polygon outer ring has fewer than 4 coordinates (${Array.isArray(outer) ? outer.length : 0} found).`
        })
      } else {
        const first = outer[0]
        const last = outer[outer.length - 1]
        if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
          errors.push({
            featureId: feature.id,
            role,
            kind: feature.kind,
            geometryType: 'Polygon',
            message: 'Polygon outer ring is unclosed (start coordinate does not match end coordinate).'
          })
        }
        let hasInvalid = false
        let allIdentical = true
        for (let i = 0; i < outer.length; i++) {
          const pt = outer[i]
          if (!Array.isArray(pt) || pt.length < 2 || !isValidCoordinate(pt[0], pt[1])) {
            errors.push({
              featureId: feature.id,
              role,
              kind: feature.kind,
              geometryType: 'Polygon',
              message: `Polygon outer ring coordinate #${i} is non-finite, invalid, or out of spherical bounds.`
            })
            hasInvalid = true
            break
          }
          if (i > 0 && (pt[0] !== first[0] || pt[1] !== first[1])) {
            allIdentical = false
          }
        }
        if (!hasInvalid && allIdentical) {
          errors.push({
            featureId: feature.id,
            role,
            kind: feature.kind,
            geometryType: 'Polygon',
            message: 'Polygon outer ring has zero area (all vertices are identical).'
          })
        }
      }

      // Check inner rings (holes)
      for (let r = 1; r < rings.length; r++) {
        const inner = rings[r]
        if (!Array.isArray(inner) || inner.length < 4) {
          errors.push({
            featureId: feature.id,
            role,
            kind: feature.kind,
            geometryType: 'Polygon',
            message: `Polygon inner ring (hole #${r}) has fewer than 4 coordinates.`
          })
        } else {
          const first = inner[0]
          const last = inner[inner.length - 1]
          if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
            errors.push({
              featureId: feature.id,
              role,
              kind: feature.kind,
              geometryType: 'Polygon',
              message: `Polygon inner ring (hole #${r}) is unclosed.`
            })
          }
        }
      }
    }
  } else if (geomType === 'MultiPolygon') {
    const parts = (geom as GeoJSON.MultiPolygon).coordinates
    if (!Array.isArray(parts) || parts.length === 0) {
      errors.push({
        featureId: feature.id,
        role,
        kind: feature.kind,
        geometryType: 'MultiPolygon',
        message: 'MultiPolygon has no polygon parts.'
      })
    } else {
      for (let p = 0; p < parts.length; p++) {
        const rings = parts[p]
        if (!Array.isArray(rings) || rings.length === 0 || !Array.isArray(rings[0]) || rings[0].length < 4) {
          errors.push({
            featureId: feature.id,
            role,
            kind: feature.kind,
            geometryType: 'MultiPolygon',
            message: `MultiPolygon part #${p} outer ring has fewer than 4 coordinates.`
          })
        } else {
          const outer = rings[0]
          const first = outer[0]
          const last = outer[outer.length - 1]
          if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
            errors.push({
              featureId: feature.id,
              role,
              kind: feature.kind,
              geometryType: 'MultiPolygon',
              message: `MultiPolygon part #${p} outer ring is unclosed.`
            })
          }
        }
      }
    }
  }

  return errors
}

/**
 * Finds all blocking geometry errors across included features in a project.
 * Excluded features (via category-level or feature-level inclusions) are ignored.
 */
export function findProjectBlockingGeometryErrors(
  features: EditorFeature[],
  inclusions?: Record<string, boolean>
): BlockingGeometryError[] {
  const errors: BlockingGeometryError[] = []
  const activeInclusions = inclusions || {}

  for (const feature of features) {
    const cat = mapKindToCategory(feature.kind, feature.role)
    if ((cat === 'cycleway' || cat === 'bike_lane') && activeInclusions.cycling === false) {
      continue
    }
    if (
      activeInclusions[cat] === false ||
      activeInclusions[feature.kind] === false ||
      (feature.role && activeInclusions[feature.role] === false)
    ) {
      continue
    }
    if (
      feature.properties?.exportInclusion === false ||
      (feature as unknown as Record<string, unknown>).exportInclusion === false
    ) {
      continue
    }

    const featureErrors = findFeatureBlockingGeometryErrors(feature)
    if (featureErrors.length > 0) {
      errors.push(...featureErrors)
    }
  }

  return errors
}
