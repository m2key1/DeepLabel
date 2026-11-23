import { useEffect, useLayoutEffect, useRef } from 'react'
import { llmReferenceImageUrl } from '../../api'
import type { LlmReference } from '../../api'

/** A picture set in the wording where it stands, as the backend reads it (llm.IMAGE_TOKEN). */
const IMAGE_TOKEN = /\{\{image:(\d+)\}\}/g
const token = (id: number) => `{{image:${id}}}`

/** The wording as stored: the text as typed, each picture as its token. */
function serialize(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? ''
    } else if (child instanceof HTMLElement && child.dataset.imageId) {
      out += token(Number(child.dataset.imageId))
    } else if (child.nodeName === 'BR') {
      out += '\n'
    } else if (child instanceof HTMLElement) {
      // A browser may wrap a new line in a block of its own instead of a break.
      const inner = serialize(child)
      out += (/^(DIV|P)$/.test(child.nodeName) && out && !out.endsWith('\n') ? '\n' : '') + inner
    }
  })
  return out
}

/** One picture as the editor shows it: never typed into, removed as a whole by Backspace
 *  or its own x. */
function chip(picture: LlmReference, onRemove: (chip: HTMLElement) => void): HTMLElement {
  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.dataset.imageId = String(picture.id)
  span.setAttribute('data-testid', 'prompt-picture')
  span.title = picture.filename
  span.className = 'mx-0.5 inline-flex items-center gap-1 rounded border border-accent/40 bg-accent-wash '
    + 'py-0.5 pl-0.5 pr-1 align-middle font-sans text-[11px] text-accent-ink'
  const img = document.createElement('img')
  img.src = llmReferenceImageUrl(picture.id)
  img.alt = ''
  img.className = 'h-5 w-7 rounded-sm bg-ground object-contain'
  const name = document.createElement('span')
  name.textContent = picture.filename
  name.className = 'max-w-32 truncate'
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = '×'
  remove.setAttribute('aria-label', `Take ${picture.filename} out of the prompt`)
  remove.className = 'leading-none text-ink-muted hover:text-danger'
  remove.addEventListener('mousedown', (e) => {
    e.preventDefault()
    onRemove(span)
  })
  span.append(img, name, remove)
  return span
}

/** The wording a model is asked with, always open: typed into like text, with pictures
 *  placed at the cursor and sent exactly where they stand. Reports every change as the
 *  stored wording; saving is the caller's. */
export function PromptEditor({ value, onChange, pictures, label, testId }: {
  value: string
  onChange: (next: string) => void
  /** The pictures the wording may place: the person's own. */
  pictures: LlmReference[]
  label: string
  testId: string
}) {
  const box = useRef<HTMLDivElement>(null)
  // The wording the box last showed or reported, so an echo of a change made here does not
  // rebuild it under the cursor.
  const shown = useRef<string | null>(null)
  // The pictures the box was last built with: one gone since takes its chip with it.
  const builtWith = useRef('')
  const caret = useRef<Range | null>(null)

  const report = () => {
    if (!box.current) return
    const next = serialize(box.current)
    shown.current = next
    onChange(next)
  }
  const removeChip = (element: HTMLElement) => {
    element.remove()
    report()
  }

  useLayoutEffect(() => {
    const el = box.current
    const ids = pictures.map((p) => p.id).join()
    if (!el || (value === shown.current && ids === builtWith.current)) return
    builtWith.current = ids
    const byId = new Map(pictures.map((p) => [p.id, p]))
    el.replaceChildren()
    let at = 0
    for (const found of value.matchAll(IMAGE_TOKEN)) {
      el.append(value.slice(at, found.index))
      const picture = byId.get(Number(found[1]))
      if (picture) el.append(chip(picture, removeChip))
      at = found.index! + found[0].length
    }
    el.append(value.slice(at))
    shown.current = value
  // removeChip only closes over refs and onChange's latest call through report.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, pictures])

  // Where the cursor was when the box last had it, so a picture chosen below goes there.
  useEffect(() => {
    const remember = () => {
      const selection = document.getSelection()
      if (selection?.rangeCount && box.current?.contains(selection.anchorNode)) {
        caret.current = selection.getRangeAt(0).cloneRange()
      }
    }
    document.addEventListener('selectionchange', remember)
    return () => document.removeEventListener('selectionchange', remember)
  }, [])

  const insert = (node: Node) => {
    const el = box.current
    if (!el) return
    const selection = document.getSelection()!
    // Where the cursor is while the box has it - the remembered caret trails a fast typist -
    // and the remembered one when a picture button below took the click.
    const live = selection.rangeCount && el.contains(selection.anchorNode) ? selection.getRangeAt(0) : null
    el.focus()
    let range = live ?? (caret.current && el.contains(caret.current.startContainer) ? caret.current : null)
    if (!range) {
      range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
    }
    range.deleteContents()
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    caret.current = range.cloneRange()
    report()
  }

  /** A line break the browser makes itself: one placed by hand at the end of the text leaves
   *  the browser typing in front of it. */
  const newLine = () => {
    if (!document.execCommand('insertLineBreak')) insert(document.createTextNode('\n'))
  }

  return (
    <div>
      <div
        ref={box}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-testid={testId}
        contentEditable
        suppressContentEditableWarning
        onInput={report}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            newLine()
          }
        }}
        onPaste={(e) => {
          e.preventDefault()
          e.clipboardData.getData('text/plain').split('\n').forEach((line, i) => {
            if (i) newLine()
            if (line) document.execCommand('insertText', false, line)
          })
        }}
        className="max-h-80 min-h-32 w-full overflow-auto whitespace-pre-wrap rounded border border-line-strong bg-surface px-2 py-1.5 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none"
      />
      {pictures.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted" data-testid="prompt-pictures">
          <span>Place at the cursor:</span>
          {pictures.map((picture) => (
            <button
              key={picture.id}
              type="button"
              data-testid="prompt-place-picture"
              data-name={picture.filename}
              title={`Place ${picture.filename} where the cursor is`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(chip(picture, removeChip))}
              className="inline-flex items-center gap-1 rounded border border-line px-1 py-0.5 hover:border-accent hover:text-accent-ink"
            >
              <img src={llmReferenceImageUrl(picture.id)} alt="" className="h-5 w-7 rounded-sm bg-ground object-contain" />
              <span className="max-w-32 truncate">{picture.filename}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
