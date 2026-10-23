import { useEffect, useRef } from 'react'
import { CLIENT_ID, pageEventsUrl } from '../api'
import type { PageChangeEvent } from '../api'

/** Streams the revisions that touch a page from `since` on, and calls `onChange` for every
 *  batch holding one this tab did not write - a colleague's, or the same person's in
 *  another tab or on another device. This tab's own edits are already applied from their
 *  responses. */
export function usePageLiveFeed(pageId: number | undefined, since: number, onChange: () => void) {
  const sinceRef = useRef(since)
  sinceRef.current = since
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    if (pageId === undefined) return
    const source = new EventSource(pageEventsUrl(pageId, sinceRef.current))
    source.onmessage = (event) => {
      const { changes } = JSON.parse(event.data) as PageChangeEvent
      if (changes.some((change) => change.client !== CLIENT_ID)) onChangeRef.current()
    }
    return () => source.close()
  }, [pageId])
}
