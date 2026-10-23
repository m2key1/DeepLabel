import type { PageElement } from '../api'

// Schematismus' rule lines: drawn, but not selectable and not counted
export const DECORATIVE = new Set(['Divider'])

// Anything a reviewer may correct. Wider than the read-only view, which hides
// containers and dividers: exhaustive annotation needs every category reachable.
export const isEditable = (el: PageElement) => el.kind !== 'orphan'

// The pseudo-class for text lines in the unified editor's rail and visibility set.
export const LINE_CLASS = 'Line'
