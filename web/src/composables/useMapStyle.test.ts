import { describe, it, expect, beforeEach } from 'bun:test'
import { useMapStyle, NEUTRAL_MUTED_STYLE, HIDDEN_BLANK_STYLE } from './useMapStyle'

describe('useMapStyle', () => {
  const store: Record<string, string> = {}
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    const storageMock: Storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { for (const k of Object.keys(store)) delete store[k] },
      key: (idx: number) => Object.keys(store)[idx] ?? null,
      length: Object.keys(store).length
    }
    Object.defineProperty(globalThis, 'localStorage', {
      value: storageMock,
      configurable: true,
      writable: true
    })
  })
  it('offers neutral muted and hidden blank basemap styles', () => {
    const { styles } = useMapStyle()
    const neutral = styles.find((s) => s.id === 'neutral-muted')
    expect(neutral).toBeDefined()
    expect(neutral?.type).toBe('neutral')
    expect(neutral?.style).toEqual(NEUTRAL_MUTED_STYLE)

    const hidden = styles.find((s) => s.id === 'none-hidden')
    expect(hidden).toBeDefined()
    expect(hidden?.type).toBe('hidden')
    expect(hidden?.style).toEqual(HIDDEN_BLANK_STYLE)
  })

  it('allows switching to neutral or hidden basemap styles without confusing underlying tiles with editable features', () => {
    const { currentStyle, currentStyleId, setStyle } = useMapStyle()

    setStyle('neutral-muted')
    expect(currentStyleId.value).toBe('neutral-muted')
    expect(currentStyle.value.type).toBe('neutral')
    expect(currentStyle.value.style).toEqual(NEUTRAL_MUTED_STYLE)

    setStyle('none-hidden')
    expect(currentStyleId.value).toBe('none-hidden')
    expect(currentStyle.value.type).toBe('hidden')
    expect(currentStyle.value.style).toEqual(HIDDEN_BLANK_STYLE)

    // Switch back to vector-liberty
    setStyle('vector-liberty')
    expect(currentStyleId.value).toBe('vector-liberty')
    expect(currentStyle.value.type).toBe('vector')
  })

  it('preserves camera position and active feature selection when switching basemap styles', () => {
    const { setStyle, currentStyleId } = useMapStyle()

    // Simulate camera and editor selection state maintained in editor model
    const cameraState = {
      center: [-71.110368, 42.415261] as [number, number],
      zoom: 17.5,
      bearing: 15,
      pitch: 0
    }
    let selectedFeatureId: string | null = 'road_123'
    let selectedStripId: string | null = 'strip_bike_right'

    // Switch styles across vector, neutral, and hidden
    setStyle('neutral-muted')
    expect(currentStyleId.value).toBe('neutral-muted')
    // Selection and camera remain completely undisturbed by basemap/style changes
    expect(selectedFeatureId).toBe('road_123')
    expect(selectedStripId).toBe('strip_bike_right')
    expect(cameraState.center).toEqual([-71.110368, 42.415261])
    expect(cameraState.zoom).toBe(17.5)

    setStyle('none-hidden')
    expect(currentStyleId.value).toBe('none-hidden')
    expect(selectedFeatureId).toBe('road_123')
    expect(selectedStripId).toBe('strip_bike_right')
    expect(cameraState.center).toEqual([-71.110368, 42.415261])

    setStyle('vector-liberty')
    expect(currentStyleId.value).toBe('vector-liberty')
    expect(selectedFeatureId).toBe('road_123')
    expect(selectedStripId).toBe('strip_bike_right')
  })
})
