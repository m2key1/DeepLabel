import { Modal, modalBtn } from '../Modal'
import type { CorpusDocument } from '../../lib/corpusApi'
import { CorpusDocuments } from './CorpusDocuments'

/** The whole-document transcriptions a dataset is cut against, added and removed from the
 *  dataset's More menu. */
export function DocumentsDialog({ jobId, documents, onChanged, onClose }: {
  jobId: string
  documents: CorpusDocument[]
  onChanged: () => void
  onClose: () => void
}) {
  return (
    <Modal title="Documents" onClose={onClose}>
      <CorpusDocuments jobId={jobId} documents={documents} onChanged={onChanged} />
      <div className="mt-4 flex justify-end border-t border-line pt-3">
        <button onClick={onClose} className={modalBtn}>Close</button>
      </div>
    </Modal>
  )
}
