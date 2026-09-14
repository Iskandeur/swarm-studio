import { useEffect } from 'react'
import { useStore } from '../store'

export interface Shortcut {
  keys: string
  what: string
}

/** Shown in the help dialog, and the single source of truth for what is actually bound below. */
export const SHORTCUTS: Shortcut[] = [
  { keys: 'Delete / Backspace', what: 'Delete the selected agent' },
  { keys: 'Ctrl/⌘ + Z', what: 'Undo' },
  { keys: 'Ctrl/⌘ + Shift + Z', what: 'Redo' },
  { keys: 'Ctrl/⌘ + Enter', what: 'Run the swarm, or stop it' },
  { keys: 'Ctrl/⌘ + D', what: 'Duplicate the selected agent' },
  { keys: 'Ctrl/⌘ + A', what: 'Tick every agent for bulk editing' },
  { keys: 'N', what: 'Add an agent' },
  { keys: 'Escape', what: 'Deselect, or clear the bulk selection' },
  { keys: '?', what: 'This list' },
]

/**
 * Whether a keystroke belongs to whatever the user is typing into.
 *
 * Without this check, pressing Backspace while editing a system prompt would delete the agent —
 * which is exactly the kind of shortcut that makes people distrust an app.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  // Boolean(): `isContentEditable` is undefined on plain elements in some engines, and returning
  // undefined from a predicate typed `boolean` is how a lie gets past the type checker.
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable)
}

/** Binds the shortcuts a graph editor is expected to have. `onHelp` opens the cheat sheet. */
export function useHotkeys({ onHelp }: { onHelp: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const store = useStore.getState()
      const mod = event.metaKey || event.ctrlKey

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        if (store.phase === 'running') store.stop()
        else store.start()
        return
      }
      if (mod && event.key.toLowerCase() === 'd') {
        if (!store.selectedId) return
        event.preventDefault()
        store.duplicateAgent(store.selectedId)
        return
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        store.setMulti(store.spec.agents.map((a) => a.id))
        return
      }
      if (mod) return

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (store.multiIds.length > 0) {
          event.preventDefault()
          store.removeAgents(store.multiIds)
        } else if (store.selectedId) {
          event.preventDefault()
          store.removeAgent(store.selectedId)
        }
        return
      }
      if (event.key === 'Escape') {
        store.select(undefined)
        store.setMulti([])
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        onHelp()
        return
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        store.addAgent()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onHelp])
}
