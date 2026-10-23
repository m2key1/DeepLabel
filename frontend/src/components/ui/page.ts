/** The column every ordinary page sits in. One constant so a new page cannot pick its own
 *  width by accident - which is how seven of them ended up with six. */
export const pageShell = 'mx-auto max-w-6xl px-4 py-6'

/** The dataset page alone: it puts a page table beside a layout preview, and that pairing
 *  crowds at the standard width. The two canvas editors and the augmentation builder take
 *  the whole window instead and use no shell at all. */
export const widePageShell = 'mx-auto max-w-[1600px] px-4 py-6'
