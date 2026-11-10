import type { Page } from '@playwright/test'

/** Text and controls on the page that nobody can bring onto the screen: pushed past its
 *  edge where nothing scrolls, or cut off by a box that hides what does not fit. A page that
 *  scrolls sideways as a whole is reported too - only a box inside it, a table's card, may.
 *  Text cut short with an ellipsis is meant to be, and scan surfaces pan, so neither counts. */
export function unreachable(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = []
    const width = document.documentElement.clientWidth
    const main = document.querySelector('[data-testid="app-main"]')
    for (const [name, box] of [['page', document.documentElement], ['main', main]] as const) {
      if (box && box.scrollWidth > box.clientWidth + 1) {
        found.push(`${name} scrolls sideways by ${box.scrollWidth - box.clientWidth}px`)
      }
    }
    const shown = (el: Element) => {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
      const r = el.getBoundingClientRect()
      return r.width > 2 && r.height > 2
    }
    const worthReaching = (el: Element) => {
      if (el.closest('svg, canvas, .openseadragon-container, [aria-hidden="true"], [inert], .sr-only')) return false
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|TH|TD|LABEL)$/.test(el.tagName)) return true
      if (/button|tab|link|checkbox|slider|switch|menuitem/.test(el.getAttribute('role') ?? '')) return true
      return [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
    }
    const named = (el: Element, why: string) => {
      const testid = el.closest('[data-testid]')?.getAttribute('data-testid') ?? ''
      const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')
      return `${el.tagName.toLowerCase()}[${testid}] "${text.slice(0, 30)}" ${why}`
    }
    for (const el of document.body.querySelectorAll('*')) {
      if (!worthReaching(el) || !shown(el)) continue
      let reach = el.getBoundingClientRect()
      let reached: Element = el
      let why: string | null = null
      let shortened = false
      for (let box = el.parentElement; box && box !== document.documentElement; box = box.parentElement) {
        const style = getComputedStyle(box)
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && box !== main) {
          reached = box
          reach = box.getBoundingClientRect()
          continue
        }
        if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue
        if (style.textOverflow === 'ellipsis' || getComputedStyle(reached).textOverflow === 'ellipsis') {
          shortened = true
          break
        }
        const edge = box.getBoundingClientRect()
        if (reach.right > edge.right + 1 || reach.left < edge.left - 1) {
          why = `cut off by ${box.tagName.toLowerCase()}[${box.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}]`
          break
        }
      }
      if (!why && !shortened && (reach.right > width + 1 || reach.left < -1)) {
        why = `off screen (${Math.round(reach.left)}..${Math.round(reach.right)} of ${width})`
      }
      if (why) found.push(named(el, why))
    }
    return [...new Set(found)]
  })
}
