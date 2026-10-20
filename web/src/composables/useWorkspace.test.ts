import { describe, it, expect, beforeEach } from 'bun:test'
import { useWorkspace } from './useWorkspace'
import { useEditorModel } from './useEditorModel'

describe('useWorkspace', () => {
  const { workspace, setWorkspace, toggleWorkspace } = useWorkspace()

  beforeEach(() => {
    useEditorModel().markSaved()
    setWorkspace('selector', { force: true })
  })

  it('defaults to selector workspace', () => {
    expect(workspace.value).toBe('selector')
  })

  it('sets workspace explicitly to editor', () => {
    setWorkspace('editor')
    expect(workspace.value).toBe('editor')
  })

  it('toggles between selector and editor', () => {
    expect(workspace.value).toBe('selector')
    toggleWorkspace()
    expect(workspace.value).toBe('editor')
    toggleWorkspace()
    expect(workspace.value).toBe('selector')
  })

  it('shares workspace state across composable instances', () => {
    const instanceA = useWorkspace()
    const instanceB = useWorkspace()

    instanceA.setWorkspace('editor')
    expect(instanceB.workspace.value).toBe('editor')
  })

  it('warns and guards against leaving an unsaved project in editor mode', () => {
    const model = useEditorModel({
      schemaVersion: '1.0.0',
      sourceMetadata: { source: 'custom' },
      projectionOrigin: { lon: -71.11, lat: 42.415 },
      features: [
        {
          id: 'test_road',
          kind: 'road',
          role: 'carriageway',
          sourceId: 'way/101',
          sourceGeometry: {
            coordinates: [
              [-71.11, 42.415],
              [-71.109, 42.415]
            ]
          },
          roadProfile: {
            carriagewayWidthMeters: { value: 6.0, provenance: 'inferred' },
            totalCorridorWidthMeters: 6.0,
            highwayClass: 'residential',
            layer: 0,
            strips: [
              {
                id: 'strip_carriageway',
                kind: 'carriageway',
                widthMeters: 6.0,
                provenance: 'inferred',
                offsetMeters: 0
              }
            ]
          },
          inferred: {
            width: false,
            sidewalk: false,
            bikeLane: false
          },
          properties: { name: 'Original' },
          warnings: []
        }
      ]
    })

    setWorkspace('editor', { force: true })
    expect(workspace.value).toBe('editor')

    // 1. When clean, switching back to selector succeeds without prompt
    expect(model.isDirty.value).toBe(false)
    const cleanSwitch = setWorkspace('selector')
    expect(cleanSwitch).toBe(true)
    expect(workspace.value).toBe('selector')

    // Switch back to editor and mutate to make dirty
    setWorkspace('editor')
    model.updateFeature('test_road', (f) => {
      f.properties.name = 'Dirty Road'
    })
    expect(model.isDirty.value).toBe(true)

    // 2. When dirty, user rejects prompt -> stays in editor
    const rejectedSwitch = setWorkspace('selector', { confirmLeave: () => false })
    expect(rejectedSwitch).toBe(false)
    expect(workspace.value).toBe('editor')

    // 3. User rejects toggleWorkspace -> stays in editor
    const rejectedToggle = toggleWorkspace({ confirmLeave: () => false })
    expect(rejectedToggle).toBe(false)
    expect(workspace.value).toBe('editor')

    // 4. Force leave switches to selector even when dirty
    const forcedSwitch = setWorkspace('selector', { force: true })
    expect(forcedSwitch).toBe(true)
    expect(workspace.value).toBe('selector')

    // 5. User accepts prompt -> switches to selector
    setWorkspace('editor', { force: true })
    const acceptedSwitch = setWorkspace('selector', { confirmLeave: () => true })
    expect(acceptedSwitch).toBe(true)
    expect(workspace.value).toBe('selector')

    // Clean up
    model.markSaved()
  })
})
