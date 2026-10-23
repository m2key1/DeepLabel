import { useState } from 'react'
import type { ApiError } from '../../api'
import { displayed } from '../../lib/text'
import {
  deleteDocument, readDocument, uploadDocuments, type CorpusDocument,
} from '../../lib/corpusApi'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Section } from '../ui/Section'
import { Table, type Column } from '../ui/Table'
import { Note, type NoteTone } from './Note'

const HINT = 'One .txt per document - a letter, an entry - however many scans it runs over.'

function storedNote(stored: number, skipped: string[]): string {
  const kept = `${stored} document${stored === 1 ? '' : 's'} stored.`
  if (!skipped.length) return kept
  return `${kept} Not .txt, so left out: ${skipped.join(', ')}.`
}

export function CorpusDocuments({ jobId, documents, onChanged }: {
  jobId: string
  documents: CorpusDocument[]
  onChanged: () => void
}) {
  const [note, setNote] = useState<{ tone: NoteTone; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState<{ name: string; text: string } | null>(null)

  const report = (error: unknown) =>
    setNote({ tone: 'bad', text: (error as ApiError).message })

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const outcome = await uploadDocuments(jobId, Array.from(files))
      setNote({ tone: 'ok', text: storedNote(outcome.stored, outcome.skipped) })
      onChanged()
    } catch (error) {
      report(error)
    }
    setBusy(false)
  }

  const remove = async (name: string) => {
    if (!confirm(`Remove "${name}" from the corpus?`)) return
    setBusy(true)
    try {
      await deleteDocument(jobId, name)
      setNote({ tone: 'ok', text: `Removed ${name}. Cut the corpus again to move the spans.` })
      if (opened?.name === name) setOpened(null)
      onChanged()
    } catch (error) {
      report(error)
    }
    setBusy(false)
  }

  const open = async (name: string) => {
    if (opened?.name === name) return setOpened(null)
    try {
      setOpened(await readDocument(jobId, name))
    } catch (error) {
      report(error)
    }
  }

  const columns: Column<CorpusDocument>[] = [
    {
      key: 'name',
      label: 'Document',
      cell: (document) => (
        <button
          onClick={() => void open(document.name)}
          aria-expanded={opened?.name === document.name}
          data-testid="document-open"
          className="text-accent-ink hover:underline"
        >
          {document.name}
        </button>
      ),
    },
    {
      key: 'lines',
      label: 'Lines',
      align: 'right',
      cell: (document) => (
        <span data-testid="document-lines" className="font-mono tabular-nums">{document.lines}</span>
      ),
    },
    {
      key: 'characters',
      label: 'Characters',
      align: 'right',
      cell: (document) => (
        <span className="font-mono tabular-nums text-ink-muted">
          {document.characters.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'pages',
      label: 'Pages',
      align: 'right',
      cell: (document) => (
        <span data-testid="document-pages" className="font-mono tabular-nums">
          {document.pages === 0 ? (
            <span className="text-ink-subtle" title="Not cut onto any page yet">-</span>
          ) : document.pages}
        </span>
      ),
    },
    {
      key: 'remove',
      label: '',
      align: 'right',
      cell: (document) => (
        <Button
          variant="danger"
          size="xs"
          disabled={busy}
          data-testid="document-delete"
          aria-label={`Remove ${document.name}`}
          onClick={() => void remove(document.name)}
        >
          Remove
        </Button>
      ),
    },
  ]

  return (
    <Section
      data-testid="corpus-documents"
      title="Corpus"
      description={HINT}
      actions={
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
          Add .txt
          <input
            type="file"
            multiple
            accept=".txt,text/plain"
            disabled={busy}
            data-testid="corpus-upload"
            aria-label="Corpus text files"
            onChange={(e) => {
              void upload(e.target.files)
              e.target.value = ''
            }}
            className="max-w-56 text-xs text-ink-subtle file:mr-2 file:rounded file:border file:border-line-strong file:bg-raised file:px-2 file:py-1 file:text-xs file:text-ink-muted"
          />
        </label>
      }
    >
      {documents.length === 0 ? (
        <div data-testid="documents-empty">
          <EmptyState>
            No corpus yet. Upload the transcribed text this dataset was made from - the
            filenames need share nothing with the scans, since the cut matches on the text
            itself.
          </EmptyState>
        </div>
      ) : (
        <Table
          caption="Corpus documents"
          columns={columns}
          rows={documents}
          rowKey={(document) => document.name}
          rowProps={(document) => ({
            'data-testid': 'document-row',
            'data-name': document.name,
            'data-pages': document.pages,
            'data-lines': document.lines,
          } as React.HTMLAttributes<HTMLTableRowElement>)}
        />
      )}

      {opened && (
        <pre
          data-testid="document-text"
          data-name={opened.name}
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-line bg-raised p-2 font-ocr text-xs text-ink-muted"
        >
          {displayed(opened.text)}
        </pre>
      )}

      {note && <div className="mt-2"><Note tone={note.tone} testId="documents-note">{note.text}</Note></div>}
    </Section>
  )
}
