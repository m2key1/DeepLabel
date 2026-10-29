import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { useCrumb } from '../components/NavBar'
import { ConventionCatalog } from '../components/models/ConventionCatalog'
import { buttonClass } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'
import { useAutoClear } from '../messages'

export function ConventionsPage() {
  const { isAdmin } = useAuth()
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  useCrumb('Conventions')

  return (
    <div className={pageShell}>
      <PageHeader title="Transcription conventions"
                  actions={<Link to="/models" className={buttonClass()}>Back to models</Link>}>
        The rules an OCR model can be asked to follow, and a dataset asks its annotators to keep. A flag a
        model declares is added here by itself, named as the model names it, so it can be described.
      </PageHeader>
      {error && <p className="mb-4 text-sm text-danger">{error}</p>}
      <ConventionCatalog canManage={isAdmin} onError={setError} />
    </div>
  )
}
