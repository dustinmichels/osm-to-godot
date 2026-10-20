import type { RawGeoJSONFeature } from './types'

export interface BBox2D {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface MatchedPoi {
  id: string
  name: string
  categories: string[]
  properties: Record<string, unknown>
}

export interface MatchedAddress {
  id: string
  number: string
  street: string
  full: string
  unit?: string
  postcode?: string
  locality?: string
}

export interface EnrichmentResult {
  features: RawGeoJSONFeature[]
  labeledBuildingsCount: number
}

/**
 * Standard ray-casting point-in-polygon algorithm.
 * Coordinates are [x, y] = [lon, lat].
 */
export function pointInPolygon(x: number, y: number, ring: number[][]): boolean {
  let inside = false
  const n = ring.length
  if (n < 3) return false
  let p1x = ring[0][0]
  let p1y = ring[0][1]

  for (let i = 1; i <= n; i++) {
    const p2 = ring[i % n]
    const p2x = p2[0]
    const p2y = p2[1]

    if (y > Math.min(p1y, p2y)) {
      if (y <= Math.max(p1y, p2y)) {
        if (x <= Math.max(p1x, p2x)) {
          let xinters = p1x
          if (p1y !== p2y) {
            xinters = ((y - p1y) * (p2x - p1x)) / (p2y - p1y) + p1x
          }
          if (p1x === p2x || x <= xinters) {
            inside = !inside
          }
        }
      }
    }
    p1x = p2x
    p1y = p2y
  }
  return inside
}

/**
 * Evaluates whether a point is within a GeoJSON Polygon or MultiPolygon geometry,
 * accounting for exterior boundaries and holes.
 */
export function pointInGeometry(
  x: number,
  y: number,
  geometry: { type: string; coordinates: unknown } | null | undefined
): boolean {
  if (!geometry || !geometry.coordinates) return false
  const { type, coordinates } = geometry

  if (type === 'Polygon') {
    const rings = coordinates as number[][][]
    if (!rings || rings.length === 0) return false
    // Must be inside exterior ring
    if (!pointInPolygon(x, y, rings[0])) return false
    // Must NOT be inside any hole
    for (let h = 1; h < rings.length; h++) {
      if (pointInPolygon(x, y, rings[h])) return false
    }
    return true
  }

  if (type === 'MultiPolygon') {
    const polygons = coordinates as number[][][][]
    if (!polygons || polygons.length === 0) return false
    for (let p = 0; p < polygons.length; p++) {
      const rings = polygons[p]
      if (rings && rings.length > 0 && pointInPolygon(x, y, rings[0])) {
        let inHole = false
        for (let h = 1; h < rings.length; h++) {
          if (pointInPolygon(x, y, rings[h])) {
            inHole = true
            break
          }
        }
        if (!inHole) return true
      }
    }
    return false
  }

  return false
}

/**
 * Computes the 2D bounding box [minX, minY, maxX, maxY] for a GeoJSON geometry.
 */
export function computeGeometryBBox(
  geometry: { type: string; coordinates: unknown } | null | undefined
): BBox2D | null {
  if (!geometry || !geometry.coordinates) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  function scanCoords(coords: unknown): void {
    if (!Array.isArray(coords)) return
    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const x = coords[0]
      const y = coords[1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    } else {
      for (let i = 0; i < coords.length; i++) {
        scanCoords(coords[i])
      }
    }
  }

  scanCoords(geometry.coordinates)
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Extracts best POI name following Overture schema precedence:
 * names.primary -> names.common -> name -> name:en -> brand.names.primary -> brand
 */
export function extractPoiName(props: Record<string, unknown>): string {
  if (!props) return ''
  const names = props.names
  if (names && typeof names === 'object') {
    const prim = (names as Record<string, unknown>).primary
    if (prim && String(prim).trim() && String(prim).trim() !== '<null>') {
      return String(prim).trim()
    }
    const comm = (names as Record<string, unknown>).common
    if (comm && String(comm).trim() && String(comm).trim() !== '<null>') {
      return String(comm).trim()
    }
  }
  if (props.name && String(props.name).trim() && String(props.name).trim() !== '<null>') {
    return String(props.name).trim()
  }
  if (props['name:en'] && String(props['name:en']).trim() && String(props['name:en']).trim() !== '<null>') {
    return String(props['name:en']).trim()
  }
  const brand = props.brand
  if (brand && typeof brand === 'object') {
    const bnames = (brand as Record<string, unknown>).names
    if (bnames && typeof bnames === 'object') {
      const bprim = (bnames as Record<string, unknown>).primary ?? (bnames as Record<string, unknown>).common
      if (bprim && String(bprim).trim() && String(bprim).trim() !== '<null>') {
        return String(bprim).trim()
      }
    }
  } else if (brand && typeof brand === 'string' && brand.trim() && brand.trim() !== '<null>') {
    return brand.trim()
  }
  return ''
}

/**
 * Extracts categories from POI properties.
 */
export function extractPoiCategories(props: Record<string, unknown>): string[] {
  if (!props) return []
  const result: string[] = []
  const cat = props.categories ?? props.category

  if (typeof cat === 'string' && cat.trim()) {
    result.push(cat.trim())
  } else if (Array.isArray(cat)) {
    for (const item of cat) {
      if (typeof item === 'string' && item.trim()) {
        result.push(item.trim())
      }
    }
  } else if (cat && typeof cat === 'object') {
    const catObj = cat as Record<string, unknown>
    const primary = catObj.primary ?? catObj.main
    if (typeof primary === 'string' && primary.trim()) {
      result.push(primary.trim())
    }
    if (Array.isArray(catObj.alternate)) {
      for (const alt of catObj.alternate) {
        if (typeof alt === 'string' && alt.trim() && !result.includes(alt.trim())) {
          result.push(alt.trim())
        }
      }
    }
  }

  if (result.length === 0) {
    if (typeof props.class === 'string' && props.class.trim()) {
      result.push(props.class.trim())
    }
    if (typeof props.subclass === 'string' && props.subclass.trim() && !result.includes(props.subclass.trim())) {
      result.push(props.subclass.trim())
    }
  }

  return result
}

/**
 * Extracts structured address and formatted address string.
 */
export function extractAddressInfo(props: Record<string, unknown>): {
  number: string
  street: string
  full: string
  unit?: string
  postcode?: string
  locality?: string
} {
  const num = String(props.number ?? props.house_number ?? '').trim()
  const rawStreet = String(props.street ?? '').trim()
  const street = rawStreet
    ? rawStreet.replace(/\b\w+/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase())
    : ''
  const unit = props.unit ? String(props.unit).trim() : undefined
  const postcode = props.postcode ? String(props.postcode).trim() : undefined
  const locality = typeof props.locality === 'string'
    ? props.locality.trim()
    : typeof props.city === 'string'
      ? props.city.trim()
      : undefined

  let full = ''
  if (num && street) {
    full = unit ? `${num} ${street} ${unit}` : `${num} ${street}`
  } else if (street) {
    full = unit ? `${street} ${unit}` : street
  }

  return { number: num, street, full, unit, postcode, locality }
}

/**
 * Enriches building footprint features in-memory by performing point-in-polygon matching
 * against places (POIs) and addresses, matching legacy `fetch_overture.py` parity.
 */
export function enrichBuildingFootprints(allFeatures: RawGeoJSONFeature[]): EnrichmentResult {
  const places: RawGeoJSONFeature[] = []
  const addresses: RawGeoJSONFeature[] = []
  const buildings: RawGeoJSONFeature[] = []

  for (let i = 0; i < allFeatures.length; i++) {
    const f = allFeatures[i]
    if (f.overture_type === 'place' && f.geometry?.type === 'Point') {
      places.push(f)
    } else if (f.overture_type === 'address' && f.geometry?.type === 'Point') {
      addresses.push(f)
    } else if (
      f.overture_type === 'building' &&
      (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
    ) {
      buildings.push(f)
    }
  }

  let labeledBuildingsCount = 0

  if (buildings.length === 0 || (places.length === 0 && addresses.length === 0)) {
    return { features: allFeatures, labeledBuildingsCount: 0 }
  }

  // Precompute building bounding boxes for fast bounding box pushdown filtering
  const buildingBoxes = new Array<BBox2D | null>(buildings.length)
  for (let i = 0; i < buildings.length; i++) {
    buildingBoxes[i] = computeGeometryBBox(buildings[i].geometry)
  }

  for (let bIdx = 0; bIdx < buildings.length; bIdx++) {
    const b = buildings[bIdx]
    const bProps = (b.properties = b.properties || {})
    const bGeom = b.geometry
    const bBox = buildingBoxes[bIdx]

    if (!bGeom || !bBox) continue

    const matchedPois: MatchedPoi[] = []
    const matchedPoiNames: string[] = []
    const matchedPoiCategories: string[] = []

    for (let pIdx = 0; pIdx < places.length; pIdx++) {
      const p = places[pIdx]
      const coords = p.geometry?.coordinates as number[] | undefined
      if (!coords || coords.length < 2) continue
      const px = coords[0]
      const py = coords[1]

      // Bounding box pre-filter
      if (px < bBox.minX || px > bBox.maxX || py < bBox.minY || py > bBox.maxY) {
        continue
      }

      if (pointInGeometry(px, py, bGeom)) {
        const pProps = p.properties || {}
        const pName = extractPoiName(pProps)
        const pCats = extractPoiCategories(pProps)

        if (pName) {
          matchedPoiNames.push(pName)
        }
        for (const cat of pCats) {
          if (!matchedPoiCategories.includes(cat)) {
            matchedPoiCategories.push(cat)
          }
        }

        matchedPois.push({
          id: p.id,
          name: pName,
          categories: pCats,
          properties: pProps
        })
      }
    }

    const matchedAddresses: MatchedAddress[] = []

    for (let aIdx = 0; aIdx < addresses.length; aIdx++) {
      const a = addresses[aIdx]
      const coords = a.geometry?.coordinates as number[] | undefined
      if (!coords || coords.length < 2) continue
      const ax = coords[0]
      const ay = coords[1]

      // Bounding box pre-filter
      if (ax < bBox.minX || ax > bBox.maxX || ay < bBox.minY || ay > bBox.maxY) {
        continue
      }

      if (pointInGeometry(ax, ay, bGeom)) {
        const aProps = a.properties || {}
        const addr = extractAddressInfo(aProps)
        if (addr.full) {
          matchedAddresses.push({
            id: a.id,
            number: addr.number,
            street: addr.street,
            full: addr.full,
            unit: addr.unit,
            postcode: addr.postcode,
            locality: addr.locality
          })
        }
      }
    }

    // Populate POIs on building properties
    if (matchedPoiNames.length > 0) {
      bProps.pois = matchedPois
      bProps.poi_names = matchedPoiNames
    }

    // Populate categories on building properties if derived
    if (matchedPoiCategories.length > 0) {
      bProps.poi_categories = matchedPoiCategories
      if (!bProps.categories) {
        bProps.categories = {
          primary: matchedPoiCategories[0],
          alternate: matchedPoiCategories.slice(1)
        }
      }
    }

    // Populate matched addresses on building properties
    if (matchedAddresses.length > 0) {
      bProps.matched_addresses = matchedAddresses
      if (!bProps.addresses || !Array.isArray(bProps.addresses) || bProps.addresses.length === 0) {
        const locality = matchedAddresses[0].locality || (typeof bProps.locality === 'string' ? bProps.locality : undefined)
        bProps.addresses = [
          {
            freeform: matchedAddresses[0].full,
            ...(locality ? { locality } : {})
          }
        ]
      }
    }

    // Assign building name if not already set, prioritizing POI name then street address
    const currName = extractPoiName(bProps)
    if (!currName) {
      let chosenName = ''
      if (matchedPoiNames.length > 0) {
        chosenName = matchedPoiNames[0]
      } else if (matchedAddresses.length > 0) {
        chosenName = matchedAddresses[0].full
      }

      if (chosenName) {
        bProps.name = chosenName
        if (!bProps.names || typeof bProps.names !== 'object') {
          bProps.names = {}
        }
        ;(bProps.names as Record<string, unknown>).primary = chosenName
        labeledBuildingsCount++
      }
    }
  }

  return { features: allFeatures, labeledBuildingsCount }
}
