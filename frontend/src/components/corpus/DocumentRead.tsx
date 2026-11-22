import { useCallback, useEffect, useState } from 'react'
import type { ApiError } from '../../api'
import { readCorpusSettings, type CorpusSettings } from '../../lib/corpusApi'
import { CorpusPrompt } from './CorpusPrompt'
import { DiplomaticRead } from './DiplomaticRead'

/** Reading the pages against the documents cut onto them: the models last used for it,
 *  and its own wording. */
export function DocumentRead({ jobId, onError }: { jobId: string; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<CorpusSettings | null>(null)
  // Bumped by every reload, so the read below knows the pages under it may have moved.
  const [revision, setRevision] = useState(0)
  const load = useCallback(() => {
    readCorpusSettings(jobId)
      .then((next) => {
        setSettings(next)
        setRevision((seen) => seen + 1)
      })
      .catch((failure: ApiError) => onError(failure.message))
  }, [jobId, onError])
  useEffect(() => load(), [load])

  if (!settings) return null
  return (
    <>
      <DiplomaticRead
        jobId={jobId}
        selected={settings.gt_model_ids.length > 0 ? settings.gt_model_ids : settings.llm_model_ids}
        keptInHouse={!settings.data_use.external_llm}
        revision={revision}
        onChanged={load}
      />
      <CorpusPrompt jobId={jobId} prompt={settings.gt_prompt} overlap={settings.reference_overlap} onSaved={load} />
    </>
  )
}
