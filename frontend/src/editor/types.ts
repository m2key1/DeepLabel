/** The tools both editors offer. What Draw draws is not a tool but a property of the
 *  pen: a layout class draws a box, the Line pen a line, a map class a polygon. */
export type Tool = 'select' | 'hand' | 'draw' | 'erase' | 'detect'

/** What an editor can do, so the shared chrome shows only the tools and gestures that
 *  exist here: a scan has no eraser brush, a tile has no rotate ring. */
export interface Capabilities {
  erase: boolean
  detect: boolean
}

/** One entry of the pen panel: what the next shape will be. */
export interface Pen {
  key: string | number
  label: string
  /** A stored colour, as a map class carries; a layout class is coloured by its name. */
  color: string
  /** The digit that picks it, when it is among the first nine. */
  digit: number | null
}
