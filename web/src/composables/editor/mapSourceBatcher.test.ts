import { describe, it, expect, mock } from 'bun:test'
import { createMapSourceBatcher, GeoJSONSourceLike } from './mapSourceBatcher'

describe('createMapSourceBatcher', () => {
  it('batches multiple updates to the same source in the same cycle', async () => {
    const batcher = createMapSourceBatcher()
    const setDataMock = mock((_data: GeoJSON.GeoJSON) => {})
    const mockSource: GeoJSONSourceLike = {
      setData: setDataMock
    }

    const featureA: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    const featureB: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }]
    }

    batcher.scheduleUpdate('test-source', () => mockSource, () => featureA)
    batcher.scheduleUpdate('test-source', () => mockSource, () => featureB)

    // Before flush, setData has not been called
    expect(setDataMock).not.toHaveBeenCalled()

    // Flush pending updates
    batcher.flushUpdates()

    // Should only be called once with the latest data
    expect(setDataMock).toHaveBeenCalledTimes(1)
    expect(setDataMock).toHaveBeenCalledWith(featureB)
  })

  it('updates multiple different sources in a single flush', () => {
    const batcher = createMapSourceBatcher()
    const setData1 = mock((_data: GeoJSON.GeoJSON) => {})
    const setData2 = mock((_data: GeoJSON.GeoJSON) => {})
    const source1: GeoJSONSourceLike = { setData: setData1 }
    const source2: GeoJSONSourceLike = { setData: setData2 }

    const fc1: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    const fc2: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

    batcher.scheduleUpdate('source-1', () => source1, () => fc1)
    batcher.scheduleUpdate('source-2', () => source2, () => fc2)

    batcher.flushUpdates()

    expect(setData1).toHaveBeenCalledTimes(1)
    expect(setData2).toHaveBeenCalledTimes(1)
  })

  it('cancels pending updates on cancelPending', () => {
    const batcher = createMapSourceBatcher()
    const setDataMock = mock((_data: GeoJSON.GeoJSON) => {})
    const mockSource: GeoJSONSourceLike = { setData: setDataMock }

    batcher.scheduleUpdate('source-1', () => mockSource, () => ({ type: 'FeatureCollection', features: [] }))
    batcher.cancelPending()
    batcher.flushUpdates()

    expect(setDataMock).not.toHaveBeenCalled()
  })
})
