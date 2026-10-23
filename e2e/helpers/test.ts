import { test as base, expect } from '@playwright/test'

// The browser never draws the OS cursor, so watching a headed run shows clicks
// happening "from nowhere". With E2E_CURSOR set, every page gets a dot that
// follows the synthetic mouse events and pulses on mousedown.
function injectCursor() {
  const ensureDot = () => {
    let dot = document.getElementById('e2e-cursor')
    if (!dot && document.body) {
      dot = document.createElement('div')
      dot.id = 'e2e-cursor'
      Object.assign(dot.style, {
        position: 'fixed',
        left: '0px',
        top: '0px',
        width: '18px',
        height: '18px',
        margin: '-9px 0 0 -9px',
        borderRadius: '50%',
        background: 'rgba(220, 38, 38, 0.5)',
        border: '2px solid rgba(220, 38, 38, 0.9)',
        pointerEvents: 'none',
        zIndex: '2147483647',
        transition: 'transform 80ms ease-out',
      })
      document.body.appendChild(dot)
    }
    return dot
  }
  document.addEventListener(
    'mousemove',
    (e) => {
      const dot = ensureDot()
      if (dot) {
        dot.style.left = `${e.clientX}px`
        dot.style.top = `${e.clientY}px`
      }
    },
    true,
  )
  document.addEventListener('mousedown', () => {
    const dot = ensureDot()
    if (dot) dot.style.transform = 'scale(1.8)'
  }, true)
  document.addEventListener('mouseup', () => {
    const dot = ensureDot()
    if (dot) dot.style.transform = 'scale(1)'
  }, true)
}

export const test = base.extend({
  page: async ({ page }, use) => {
    if (process.env.E2E_CURSOR) await page.addInitScript(injectCursor)
    await use(page)
  },
})

export { expect }
