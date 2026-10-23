import type { LineCandidate } from '../../api'

const UNNAMED = 'model.ckpt'

/** The author prefixes that are not people - the server's store.MACHINE_AUTHORS. */
const MACHINE_AUTHORS = ['model:', 'llm:', 'align:', 'realign:', 'system:', 'import:']

/** Whether a stored author is a model, an alignment or the system rather than a person.
 *  An author nobody recorded is not a machine: what was written before authors were
 *  kept is a person's work until shown otherwise. */
export function isMachineAuthor(author: string | null): boolean {
  return author !== null && MACHINE_AUTHORS.some((prefix) => author.startsWith(prefix))
}

const DIPLOMATIC = 'align:llm'

/** A diplomatic reading names its model after the prefix; one offered before models were
 *  named, or the alignment of one, names none. */
function alignedName(author: string): string {
  if (!author.startsWith(DIPLOMATIC)) return 'transcript'
  const model = author.startsWith(`${DIPLOMATIC}:`) ? author.slice(DIPLOMATIC.length + 1) : ''
  return model ? `diplomatic reading - ${model}` : 'diplomatic reading'
}

/** Who said it, short enough for a chip: the language model's own name, the checkpoint
 *  the local model read under, the person who typed it. The stored author carries the
 *  vocabulary the revision log uses ("llm:", "model:ocr@"), which is not for reading. */
export function readerName(source: LineCandidate['source'], author: string): string {
  if (source === 'llm') return author.replace(/^llm:/, '')
  if (source === 'align') return alignedName(author)
  if (source !== 'ocr') return author
  const checkpoint = author.replace(/^model:/, '').replace(/^ocr@/, '').replace(/\.pt$/, '')
  // Every training writes its weights to model.ckpt, so a reading stored before the name
  // went into the author names no model - and the dataset it sits in names none either,
  // or the server would have resolved it.
  if (checkpoint === 'ocr' || checkpoint.startsWith(UNNAMED)) return 'OCR'
  return checkpoint || 'OCR'
}
