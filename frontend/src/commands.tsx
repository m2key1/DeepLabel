import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { commandsFor, eventCombo, useSettings } from './settings'

type Handler = () => void

interface CommandsCtx {
  register: (id: string, run: Handler) => () => void
}

const Ctx = createContext<CommandsCtx | null>(null)

// A key press belongs to whatever is reading keys: the field someone is typing in, or a
// control waiting to be told which key it should answer to. Without the second, pressing
// a key to bind it would also run the command it was just bound to.
function claimsKeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable ||
    el.hasAttribute('data-capture-keys')
  )
}

/** Runs the command a combo is bound to, if something on screen offers it.
 *
 *  Only commands a mounted button has registered are dispatched here, so a binding is
 *  inert on a page where the action does not exist rather than doing something
 *  surprising. The page viewer and map editor dispatch their own from the same
 *  bindings, which is why an unregistered id falls through untouched. */
export function CommandsProvider({ children }: { children: ReactNode }) {
  const { hotkeys } = useSettings()
  const handlers = useRef(new Map<string, Handler>())
  // The listener is bound once, so it reads the bindings through a ref rather than
  // closing over a value that a Settings change would leave stale.
  const bindings = useRef(hotkeys)
  bindings.current = hotkeys

  const register = useCallback((id: string, run: Handler) => {
    handlers.current.set(id, run)
    return () => {
      if (handlers.current.get(id) === run) handlers.current.delete(id)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = eventCombo(e)
      if (!combo) return
      if (claimsKeys(e.target)) return
      // Two commands may share a key when they can never be on screen together; the one
      // with a button mounted is the one that is here.
      const run = commandsFor(bindings.current, combo).map((id) => handlers.current.get(id)).find(Boolean)
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return <Ctx.Provider value={{ register }}>{children}</Ctx.Provider>
}

/** Offer a command while this component is mounted, so the key that runs it is the one
 *  its owner chose in Settings. `enabled` withdraws it - a button nobody may press must
 *  not answer to a key either. */
export function useCommand(id: string, run: Handler, enabled = true) {
  const ctx = useContext(Ctx)
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    if (!ctx || !enabled) return
    return ctx.register(id, () => latest.current())
  }, [ctx, id, enabled])
}
