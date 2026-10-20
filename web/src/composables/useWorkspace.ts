import { ref } from 'vue'
import { useBBox } from './useBBox'
import { useEditorModel } from './useEditorModel'

export type WorkspaceMode = 'selector' | 'editor'

export interface SetWorkspaceOptions {
  force?: boolean
  confirmLeave?: (message: string) => boolean
}

const currentWorkspace = ref<WorkspaceMode>('selector')

export function useWorkspace() {
  function setWorkspace(mode: WorkspaceMode, options: SetWorkspaceOptions = {}): boolean {
    if (mode === 'selector' && currentWorkspace.value === 'editor' && !options.force) {
      const { isDirty, confirmLeaveProject } = useEditorModel()
      if (isDirty.value) {
        const confirmed = options.confirmLeave
          ? options.confirmLeave('You have unsaved edits in the active project. Return to Area Selector anyway?')
          : confirmLeaveProject('return to Area Selector')
        if (!confirmed) {
          return false
        }
      }
    }
    currentWorkspace.value = mode
    if (mode === 'editor') {
      useBBox().cancelDrawing()
    }
    return true
  }

  function toggleWorkspace(options: SetWorkspaceOptions = {}): boolean {
    const next = currentWorkspace.value === 'selector' ? 'editor' : 'selector'
    return setWorkspace(next, options)
  }

  return {
    workspace: currentWorkspace,
    setWorkspace,
    toggleWorkspace
  }
}
