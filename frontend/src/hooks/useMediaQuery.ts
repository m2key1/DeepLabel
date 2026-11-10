import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', changed)
      return () => list.removeEventListener('change', changed)
    },
    () => window.matchMedia(query).matches,
  )
}

/** Below a tablet's width (Tailwind's md): too narrow for everything the top bar holds. */
export const useIsNarrow = () => useMediaQuery('(max-width: 767px)')

/** A phone: narrow and touched. It reads the scan and its text one at a time, where a narrow
 *  window on a computer keeps both, as it always has. */
export const useIsPhone = () => useMediaQuery('(max-width: 767px) and (pointer: coarse)')
