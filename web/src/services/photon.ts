export interface PhotonFeature {
  geometry: {
    coordinates: [number, number] // [lon, lat]
    type: 'Point'
  }
  type: 'Feature'
  properties: {
    osm_id?: number
    osm_type?: string
    name?: string
    street?: string
    housenumber?: string
    postcode?: string
    city?: string
    state?: string
    country?: string
    countrycode?: string
    type?: string
    extent?: [number, number, number, number] // [minLon, maxLat, maxLon, minLat] or [west, north, east, south]
  }
}

export interface PhotonResponse {
  type: 'FeatureCollection'
  features: PhotonFeature[]
}

export function formatPhotonFeature(feature: PhotonFeature): string {
  const p = feature.properties
  const parts: string[] = []

  if (p.name) {
    parts.push(p.name)
  }

  const streetAndNumber = [p.street, p.housenumber].filter(Boolean).join(' ')
  if (streetAndNumber && streetAndNumber !== p.name) {
    parts.push(streetAndNumber)
  }

  const city = p.city || p.state
  if (city && city !== p.name) {
    parts.push(city)
  }

  if (p.country && p.country !== p.name && p.country !== city) {
    parts.push(p.country)
  }

  return parts.length > 0 ? parts.join(', ') : 'Unknown location'
}

let activeAbortController: AbortController | null = null

export async function searchPhoton(
  query: string,
  options: {
    limit?: number
    lat?: number
    lon?: number
  } = {}
): Promise<PhotonFeature[]> {
  const trimmed = query.trim()
  if (!trimmed || trimmed.length < 2) {
    return []
  }

  if (activeAbortController) {
    activeAbortController.abort()
  }
  activeAbortController = new AbortController()

  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', trimmed)
  url.searchParams.set('limit', String(options.limit ?? 6))

  if (options.lat !== undefined && options.lon !== undefined) {
    url.searchParams.set('lat', options.lat.toFixed(5))
    url.searchParams.set('lon', options.lon.toFixed(5))
  }

  try {
    const response = await fetch(url.toString(), {
      signal: activeAbortController.signal,
      headers: {
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(`Photon geocoder HTTP ${response.status}`)
    }

    const data: PhotonResponse = await response.json()
    return data.features || []
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return []
    }
    console.error('Photon geocode error:', err)
    return []
  }
}
