import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ApiError } from '../api'
import { CorpusDocuments } from '../components/corpus/CorpusDocuments'
import { CorpusPrompt } from '../components/corpus/CorpusPrompt'
import { DiplomaticRead } from '../components/corpus/DiplomaticRead'
import { Note } from '../components/corpus/Note'
import { ReferenceReview } from '../components/corpus/ReferenceReview'
import { useCrumb } from '../components/NavBar'
import { buttonClass } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'
import {
  listDocuments, listReference, readCorpusSettings,
  type CorpusDocument, type CorpusSettings, type ReferencePage,
} from '../lib/corpusApi'

// The backend's own ceiling. A dataset past it reads the first spans and says so, rather
// than growing paging for a page whose whole purpose is to be read straight through.
const REFERENCE_LIMIT = 2000

export function CorpusPage() {
  const { id: jobId = '' } = useParams()
  const [settings, setSettings] = useState<CorpusSettings | null>(null)
  const [documents, setDocuments] = useState<CorpusDocument[]>([])
  const [pages, setPages] = useState<ReferencePage[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  // Bumped by every reload, so the sections that hold their own state know the ground
  // under them has moved - a cut changes which pages a reading would cover.
  const [revision, setRevision] = useState(0)

  const load = useCallback(() => {
    Promise.all([
      readCorpusSettings(jobId),
      listDocuments(jobId),
      listReference(jobId, REFERENCE_LIMIT),
    ]).then(([job, corpus, reference]) => {
      setSettings(job)
      setDocuments(corpus.documents)
      setPages(reference.pages)
      setTotal(reference.total)
      setError('')
      setRevision((seen) => seen + 1)
    }).catch((failure: ApiError) => setError(failure.message))
  }, [jobId])

  useEffect(() => load(), [load])
  useCrumb(settings ? `${settings.name} · Corpus` : 'Corpus')

  return (
    <div className={pageShell}>
      <PageHeader
        title="Corpus and diplomatic reading"
        actions={
          <Link
            to={`/jobs/${jobId}`}
            data-testid="corpus-back"
            className={buttonClass({ variant: 'outline', size: 'sm' })}
          >
            Back to the dataset
          </Link>
        }
      >
        A transcribed corpus arrives as whole documents while the unit of work is the
        scanned leaf. Cutting it gives every page the part it is answerable for, and a model
        that can also see the scan turns that into the page's ground truth - machine-made,
        so nothing checks it off.
      </PageHeader>

      {error && <div className="mb-3"><Note tone="bad" testId="corpus-error">{error}</Note></div>}

      <CorpusDocuments jobId={jobId} documents={documents} onChanged={load} />

      <ReferenceReview jobId={jobId} pages={pages} onChanged={load} />
      {total > pages.length && (
        <p data-testid="reference-truncated" className="-mt-2 mb-4 text-xs text-ink-subtle">
          Showing the first {pages.length} of {total} pages.
        </p>
      )}

      {settings && (
        <>
          <DiplomaticRead
            jobId={jobId}
            selected={settings.gt_model_ids.length > 0 ? settings.gt_model_ids : settings.llm_model_ids}
            keptInHouse={!settings.data_use.external_llm}
            revision={revision}
            onChanged={load}
          />
          <CorpusPrompt
            jobId={jobId}
            prompt={settings.gt_prompt}
            overlap={settings.reference_overlap}
            onSaved={load}
          />
        </>
      )}
    </div>
  )
}
