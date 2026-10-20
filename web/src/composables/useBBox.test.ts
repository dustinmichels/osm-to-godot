import { describe, it, expect, beforeEach } from 'bun:test'
import { useBBox } from './useBBox'
import { useWorkspace } from './useWorkspace'

describe('useBBox', () => {
  const {
    currentBBox,
    normalizedBBox,
    hasBBox,
    centroid,
    dimensions,
    areaKm2,
    isWarningSize,
    isDangerSize,
    setBBox,
    clearBBox,
    updateHandlePosition,
    toggleSelectionMode,
    cancelDrawing,
    isDrawing,
    isSelectionMode,
    activeHandle,
    initDefaultBBox
  } = useBBox()

  beforeEach(() => {
    clearBBox()
  })

  it('initializes with null bbox and false interaction flags', () => {
    expect(hasBBox.value).toBe(false)
    expect(currentBBox.value).toBeNull()
    expect(normalizedBBox.value).toBeNull()
    expect(centroid.value).toBeNull()
    expect(dimensions.value).toBeNull()
    expect(areaKm2.value).toBe(0)
    expect(isDrawing.value).toBe(false)
    expect(isSelectionMode.value).toBe(false)
    expect(activeHandle.value).toBeNull()
  })

  it('sets and normalizes bounding box coordinates correctly regardless of drag direction', () => {
    setBBox({
      west: -71.10,
      south: 42.42,
      east: -71.12, // east < west (dragged backwards)
      north: 42.40  // north < south
    })

    expect(hasBBox.value).toBe(true)
    const norm = normalizedBBox.value!
    expect(norm.west).toBe(-71.12)
    expect(norm.east).toBe(-71.10)
    expect(norm.south).toBe(42.40)
    expect(norm.north).toBe(42.42)
  })

  it('calculates centroid and dimensions in meters', () => {
    initDefaultBBox(0, 0, 500)
    expect(hasBBox.value).toBe(true)
    expect(centroid.value?.lon).toBeCloseTo(0, 4)
    expect(centroid.value?.lat).toBeCloseTo(0, 4)
    expect(dimensions.value?.widthMeters).toBeGreaterThan(900)
    expect(dimensions.value?.heightMeters).toBeGreaterThan(900)
    expect(isWarningSize.value).toBe(false)
    expect(isDangerSize.value).toBe(false)
  })

  it('updates handle position when dragging perimeter handles', () => {
    setBBox({
      west: -71.12,
      south: 42.40,
      east: -71.10,
      north: 42.42
    })

    updateHandlePosition('ne', -71.08, 42.45)
    expect(currentBBox.value?.east).toBe(-71.08)
    expect(currentBBox.value?.north).toBe(42.45)
    expect(currentBBox.value?.west).toBe(-71.12)
    expect(currentBBox.value?.south).toBe(42.40)
  })

  it('cancels drawing and selection mode cleanly with cancelDrawing', () => {
    toggleSelectionMode()
    expect(isSelectionMode.value).toBe(true)

    isDrawing.value = true
    activeHandle.value = 'nw'

    cancelDrawing()
    expect(isDrawing.value).toBe(false)
    expect(isSelectionMode.value).toBe(false)
    expect(activeHandle.value).toBeNull()
  })

  it('automatically cancels area-drawing gestures when switching to editor workspace', () => {
    const { setWorkspace, workspace } = useWorkspace()
    setWorkspace('selector')

    toggleSelectionMode()
    isDrawing.value = true
    activeHandle.value = 'se'

    expect(isDrawing.value).toBe(true)
    expect(isSelectionMode.value).toBe(true)
    expect(activeHandle.value).toBe('se')

    setWorkspace('editor')
    expect(workspace.value).toBe('editor')
    expect(isDrawing.value).toBe(false)
    expect(isSelectionMode.value).toBe(false)
    expect(activeHandle.value).toBeNull()
  })
})
