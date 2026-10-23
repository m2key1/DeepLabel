import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { listModels, listTrainings } from '../api'
import type { ModelTask, RegistryModel, Training, TrainingTargets } from '../api'
import { useSetCrumbs } from '../components/NavBar'
import { TrainForm } from '../components/models/TrainForm'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'
import { widePageShell } from '../components/ui/page'

const TASKS: ModelTask[] = ['layout', 'lines', 'ocr']

const TASK_TITLE: Record<ModelTask, string> = {
  layout: 'a layout detection model',
  lines: 'a line segmentation model',
  ocr: 'an OCR model',
}

const isFinished = (status: Training['status']) =>
  status === 'done' || status === 'error' || status === 'cancelled'

/** Starting a run, as a page.
 *
 *  It was a dialog, and it outgrew one: twenty-one fields over two columns, an
 *  augmentation editor that opened on top of it, and a panel tall enough that its own
 *  footer left the window. A page has room, an address a rerun link can carry, and a
 *  back button that means what it says. */
export function TrainingNewPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const setCrumbs = useSetCrumbs()

  const asked = params.get('task')
  const task = (TASKS as string[]).includes(asked ?? '') ? (asked as ModelTask) : 'ocr'
  const fromId = Number(params.get('from'))

  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [trainings, setTrainings] = useState<Training[] | null>(null)
  const [targets, setTargets] = useState<TrainingTargets>({ local: true, slurm: false })
  const [gpuTypes, setGpuTypes] = useState<Record<string, number>>({})
  const [trainable, setTrainable] = useState<ModelTask[]>(['ocr'])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listModels(true).then((r) => setModels(r.models)).catch((e: Error) => setError(e.message))
    listTrainings()
      .then((r) => {
        setTrainings(r.trainings)
        setTargets(r.targets)
        setGpuTypes(r.gpu_types ?? {})
        setTrainable(r.trainable_tasks ?? ['ocr'])
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const from = trainings?.find((t) => t.id === fromId)

  useEffect(() => {
    setCrumbs([{ label: 'Models', to: '/models' },
               { label: from ? `Rerun ${from.name}` : 'New training run' }])
    return () => setCrumbs([])
  }, [setCrumbs, from])

  const done = models !== null && trainings !== null

  return (
    <div className={widePageShell}>
      <PageHeader title={from ? `Rerun ${from.name}` : `Train ${TASK_TITLE[task]}`}>
        {from
          ? 'Every setting starts where that run left it. Change what you meant to change.'
          : 'The datasets on the left make the run; what it is measured and shaped by is on the right.'}
      </PageHeader>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {done && !trainable.includes(task) && (
        <EmptyState>Training {TASK_TITLE[task]} is not offered yet.</EmptyState>
      )}
      {done && trainable.includes(task) && (
        <TrainForm
          task={task}
          models={models.filter((m) => m.task === task && !m.archived)}
          targets={targets}
          gpuTypes={gpuTypes}
          from={from}
          takenNames={[
            ...models.filter((m) => m.task === task).map((m) => m.name),
            ...trainings.filter((t) => t.task === task && !isFinished(t.status)).map((t) => t.name),
          ]}
          onClose={() => navigate('/models')}
          onStarted={() => navigate('/models?tab=runs')}
        />
      )}
      {!done && !error && <p className="text-sm text-ink-subtle">Loading…</p>}
    </div>
  )
}
