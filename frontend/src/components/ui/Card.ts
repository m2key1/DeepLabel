/** A panel lifted off the page. One border, one background, no shadow - the shadow was
 *  the thing that made the old panels look like they belonged to different apps. */
export const cardChrome = 'rounded-md border border-line bg-surface'

/** The same panel, floating over the page: a menu, a hover card, an info bubble. It
 *  gets the shadow because it is off the page rather than on it. */
export const popoverChrome = `${cardChrome} shadow-md`
