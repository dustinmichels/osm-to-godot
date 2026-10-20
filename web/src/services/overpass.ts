import type { BoundingBox } from '@/composables/useBBox'

export interface OSMElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  timestamp?: string
  version?: number
  tags?: Record<string, string>
  nodes?: number[]
  members?: Array<{
    type: 'node' | 'way' | 'relation'
    ref: number
    role: string
    geometry?: Array<{ lat: number; lon: number }>
  }>
  geometry?: Array<{ lat: number; lon: number }>
}

export interface OverpassResponse {
  version?: number
  generator?: string
  osm3s?: {
    timestamp_osm_base?: string
    copyright?: string
  }
  elements: OSMElement[]
}

export interface ExportMetadata {
  version: string
  generator: string
  timestamp: string
  source: 'overpass' | 'osm_0_6'
  bbox: BoundingBox
  centroid: {
    lon: number
    lat: number
    lonRad: number
    latRad: number
  }
  dimensions: {
    widthMeters: number
    heightMeters: number
    areaKm2: number
  }
  projection: {
    type: 'equirectangular_local_tangent'
    earthRadius: number
    formula: {
      x: string
      z: string
    }
    godotAxes: {
      '+X': string
      '+Y': string
      '-Z': string
      scale: string
    }
  }
  stats: {
    totalElements: number
    highwaysCount: number
    buildingsCount: number
    poisCount?: number
    relationsCount: number
  }
}

export interface OSMExportPayload {
  metadata: ExportMetadata
  elements: OSMElement[]
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
]

export function isPoiTags(tags?: Record<string, string>): boolean {
  if (!tags) return false
  return Boolean(
    tags.amenity ||
    tags.shop ||
    tags.tourism ||
    tags.leisure ||
    tags.office ||
    tags.historic ||
    tags.healthcare ||
    tags.craft ||
    (tags.name && !tags.highway && !tags.building)
  )
}

export function buildOverpassQL(bbox: BoundingBox, timeoutSeconds = 30): string {
  // Overpass expects bbox as (south, west, north, east)
  const s = bbox.south.toFixed(6)
  const w = bbox.west.toFixed(6)
  const n = bbox.north.toFixed(6)
  const e = bbox.east.toFixed(6)
  const bboxStr = `${s},${w},${n},${e}`

  return `[out:json][timeout:${timeoutSeconds}];
(
  way["highway"](${bboxStr});
  way["building"](${bboxStr});
  relation["building"](${bboxStr});
  node["amenity"](${bboxStr});
  node["shop"](${bboxStr});
  node["tourism"](${bboxStr});
  node["leisure"](${bboxStr});
  node["office"](${bboxStr});
  node["historic"](${bboxStr});
  node["healthcare"](${bboxStr});
  node["craft"](${bboxStr});
);
out body geom;`
}

export async function fetchOverpass(
  bbox: BoundingBox,
  onStatusUpdate?: (msg: string) => void
): Promise<{ elements: OSMElement[]; source: 'overpass' }> {
  const query = buildOverpassQL(bbox, 35)

  let lastError: Error | null = null

  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i]!
    try {
      onStatusUpdate?.(`Querying Overpass mirror ${i + 1}/${OVERPASS_ENDPOINTS.length}...`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 40000)

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json'
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${endpoint}`)
      }

      const data: OverpassResponse = await response.json()
      if (!Array.isArray(data.elements)) {
        throw new Error('Invalid Overpass response format')
      }

      return { elements: data.elements, source: 'overpass' }
    } catch (err: unknown) {
      console.warn(`Overpass endpoint ${endpoint} failed:`, err)
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError || new Error('All Overpass API endpoints failed')
}

export async function fetchOsmApiFallback(
  bbox: BoundingBox,
  onStatusUpdate?: (msg: string) => void
): Promise<{ elements: OSMElement[]; source: 'osm_0_6' }> {
  onStatusUpdate?.('Requesting data from OSM 0.6 API fallback...')
  // OSM 0.6 expects bbox as left,bottom,right,top (west,south,east,north)
  const w = bbox.west.toFixed(6)
  const s = bbox.south.toFixed(6)
  const e = bbox.east.toFixed(6)
  const n = bbox.north.toFixed(6)

  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${w},${s},${e},${n}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 35000)

  const response = await fetch(url, {
    headers: {
      Accept: 'application/xml, text/xml'
    },
    signal: controller.signal
  })

  clearTimeout(timeoutId)

  if (!response.ok) {
    throw new Error(`OSM 0.6 API returned HTTP ${response.status}`)
  }

  const xmlText = await response.text()
  onStatusUpdate?.('Parsing OSM 0.6 XML response...')
  const elements = parseOsmXmlToElements(xmlText)

  return { elements, source: 'osm_0_6' }
}

function parseOsmXmlToElements(xmlString: string): OSMElement[] {
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlString, 'application/xml')

    const nodesMap = new Map<number, { lat: number; lon: number }>()
    const poiNodes: OSMElement[] = []
    const nodeEls = doc.getElementsByTagName('node')
    for (let i = 0; i < nodeEls.length; i++) {
      const el = nodeEls[i]!
      const id = parseInt(el.getAttribute('id') || '0', 10)
      const lat = parseFloat(el.getAttribute('lat') || '0')
      const lon = parseFloat(el.getAttribute('lon') || '0')
      if (id) {
        nodesMap.set(id, { lat, lon })
        const tags: Record<string, string> = {}
        const children = el.children
        for (let j = 0; j < children.length; j++) {
          const child = children[j]!
          if (child.tagName === 'tag') {
            const k = child.getAttribute('k')
            const v = child.getAttribute('v')
            if (k && v) tags[k] = v
          }
        }
        if (isPoiTags(tags)) {
          poiNodes.push({
            type: 'node',
            id,
            lat,
            lon,
            tags
          })
        }
      }
    }

    const result: OSMElement[] = [...poiNodes]

    const wayEls = doc.getElementsByTagName('way')
    for (let i = 0; i < wayEls.length; i++) {
      const el = wayEls[i]!
      const id = parseInt(el.getAttribute('id') || '0', 10)
      const tags: Record<string, string> = {}
      const nodeRefs: number[] = []
      const geometry: Array<{ lat: number; lon: number }> = []

      const children = el.children
      for (let j = 0; j < children.length; j++) {
        const child = children[j]!
        if (child.tagName === 'tag') {
          const k = child.getAttribute('k')
          const v = child.getAttribute('v')
          if (k && v) tags[k] = v
        } else if (child.tagName === 'nd') {
          const ref = parseInt(child.getAttribute('ref') || '0', 10)
          if (ref) {
            nodeRefs.push(ref)
            const pt = nodesMap.get(ref)
            if (pt) geometry.push(pt)
          }
        }
      }

      if (tags.highway || tags.building) {
        result.push({
          type: 'way',
          id,
          tags,
          nodes: nodeRefs,
          geometry
        })
      }
    }

    const relEls = doc.getElementsByTagName('relation')
    for (let i = 0; i < relEls.length; i++) {
      const el = relEls[i]!
      const id = parseInt(el.getAttribute('id') || '0', 10)
      const tags: Record<string, string> = {}
      const members: OSMElement['members'] = []

      const children = el.children
      for (let j = 0; j < children.length; j++) {
        const child = children[j]!
        if (child.tagName === 'tag') {
          const k = child.getAttribute('k')
          const v = child.getAttribute('v')
          if (k && v) tags[k] = v
        } else if (child.tagName === 'member') {
          const type = child.getAttribute('type') as 'node' | 'way' | 'relation'
          const ref = parseInt(child.getAttribute('ref') || '0', 10)
          const role = child.getAttribute('role') || ''
          members.push({ type, ref, role })
        }
      }

      if (tags.building) {
        result.push({
          type: 'relation',
          id,
          tags,
          members
        })
      }
    }

    return result
  }

  // Fallback regex-based parser when DOMParser is not available (Node/Bun runtime)
  const nodesMap = new Map<number, { lat: number; lon: number }>()
  const nodeRegex = /<node\s+[^>]*\bid="(\d+)"[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = nodeRegex.exec(xmlString)) !== null) {
    const id = parseInt(match[1]!, 10)
    const lat = parseFloat(match[2]!)
    const lon = parseFloat(match[3]!)
    nodesMap.set(id, { lat, lon })
  }

  const poiNodes: OSMElement[] = []
  const nodeBlockRegex = /<node\s+[^>]*\bid="(\d+)"[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>([\s\S]*?)<\/node>/g
  while ((match = nodeBlockRegex.exec(xmlString)) !== null) {
    const id = parseInt(match[1]!, 10)
    const lat = parseFloat(match[2]!)
    const lon = parseFloat(match[3]!)
    const inner = match[4]!
    const tags: Record<string, string> = {}
    const tagRegex = /<tag\s+[^>]*k="([^"]+)"[^>]*v="([^"]+)"/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tagRegex.exec(inner)) !== null) {
      tags[tMatch[1]!] = tMatch[2]!
    }
    if (isPoiTags(tags)) {
      poiNodes.push({
        type: 'node',
        id,
        lat,
        lon,
        tags
      })
    }
  }

  const result: OSMElement[] = [...poiNodes]
  const wayBlockRegex = /<way\s+[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/way>/g
  while ((match = wayBlockRegex.exec(xmlString)) !== null) {
    const id = parseInt(match[1]!, 10)
    const inner = match[2]!

    const tags: Record<string, string> = {}
    const tagRegex = /<tag\s+[^>]*k="([^"]+)"[^>]*v="([^"]+)"/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tagRegex.exec(inner)) !== null) {
      tags[tMatch[1]!] = tMatch[2]!
    }

    if (tags.highway || tags.building) {
      const nodeRefs: number[] = []
      const geometry: Array<{ lat: number; lon: number }> = []
      const ndRegex = /<nd\s+[^>]*ref="(\d+)"/g
      let ndMatch: RegExpExecArray | null
      while ((ndMatch = ndRegex.exec(inner)) !== null) {
        const ref = parseInt(ndMatch[1]!, 10)
        nodeRefs.push(ref)
        const pt = nodesMap.get(ref)
        if (pt) geometry.push(pt)
      }

      result.push({
        type: 'way',
        id,
        tags,
        nodes: nodeRefs,
        geometry
      })
    }
  }

  const relBlockRegex = /<relation\s+[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/relation>/g
  while ((match = relBlockRegex.exec(xmlString)) !== null) {
    const id = parseInt(match[1]!, 10)
    const inner = match[2]!

    const tags: Record<string, string> = {}
    const tagRegex = /<tag\s+[^>]*k="([^"]+)"[^>]*v="([^"]+)"/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = tagRegex.exec(inner)) !== null) {
      tags[tMatch[1]!] = tMatch[2]!
    }

    if (tags.building) {
      const members: OSMElement['members'] = []
      const memRegex = /<member\s+[^>]*type="([^"]+)"[^>]*ref="(\d+)"[^>]*role="([^"]*)"/g
      let mMatch: RegExpExecArray | null
      while ((mMatch = memRegex.exec(inner)) !== null) {
        members.push({
          type: mMatch[1]! as 'node' | 'way' | 'relation',
          ref: parseInt(mMatch[2]!, 10),
          role: mMatch[3]!
        })
      }

      result.push({
        type: 'relation',
        id,
        tags,
        members
      })
    }
  }

  return result
}
