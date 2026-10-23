import { useEffect, useState } from 'react'
import { getLayoutTemplates, patchModel } from '../../api'
import type { LayoutTemplate, RegistryModel } from '../../api'
import { useAuth } from '../../auth'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Input, Select, Textarea } from '../ui/Field'

interface EditModelDialogProps {
  model: RegistryModel
  onClose: () => void
  onSaved: () => void
  onError: (message: string) => void
  /** Set on a family's root for someone who manages models: the family is named here. */
  familyName?: string
}

export function EditModelDialog({ model, onClose, onSaved, onError, familyName }: EditModelDialogProps) {
  const { isAdmin, can } = useAuth()
  const choosesTemplate = model.task === 'layout' && can('models.manage')
  const [templates, setTemplates] = useState<LayoutTemplate[]>([])
  const [templateId, setTemplateId] = useState(model.layout_template_id)
  useEffect(() => {
    if (choosesTemplate) getLayoutTemplates().then(setTemplates).catch((e: Error) => onError(e.message))
  }, [choosesTemplate, onError])
  const [name, setName] = useState(model.name)
  const [notes, setNotes] = useState(model.notes ?? '')
  const [family, setFamily] = useState(familyName ?? '')
  const [lmPath, setLmPath] = useState(model.lm_path ?? '')
  const [lmDictPath, setLmDictPath] = useState(model.lm_dict_path ?? '')
  const [busy, setBusy] = useState(false)


  const save = async () => {
    setBusy(true)
    try {
      await patchModel(model.id, {
        name: name.trim(),
        notes: notes.trim(),
        ...(familyName !== undefined && family.trim() !== familyName ? { family_name: family.trim() } : {}),
        ...(model.task === 'ocr' && isAdmin ? { lm_path: lmPath.trim(), lm_dict_path: lmDictPath.trim() } : {}),
        ...(choosesTemplate && templateId !== model.layout_template_id ? { layout_template_id: templateId } : {}),
      })
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Edit ${model.name}`} onClose={onClose}>
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor="model-name">
        Name
      </label>
      <Input
        size="md"
        id="model-name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3 w-full"
      />
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor="model-notes">
        Description
      </label>
      <Textarea
        size="md"
        id="model-notes"
        rows={3}
        placeholder="optional"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="mb-4 w-full resize-none"
      />
      {familyName !== undefined && (
        <>
          <label className="mb-1 block text-sm font-medium text-ink" htmlFor="model-family">
            Family name
          </label>
          <Input size="md" id="model-family" value={family} onChange={(e) => setFamily(e.target.value)}
                 placeholder={model.name} className="mb-1 w-full" />
          <p className="mb-4 text-xs text-ink-muted">
            Everything fine-tuned from this model is listed under it. Empty calls the family after the model.
          </p>
        </>
      )}
      {choosesTemplate && (
        <>
          <label className="mb-1 block text-sm font-medium text-ink" htmlFor="model-template">
            Layout template
          </label>
          <Select size="md" id="model-template" data-testid="model-template" value={templateId ?? ''}
                  onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
                  className="mb-1 w-full">
            <option value="">None - pages work their order out</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <p className="mb-4 text-xs text-ink-muted">
            The template whose classes it was trained on. The datasets it reads follow that template's reading order.
          </p>
        </>
      )}
      {model.task === 'ocr' && isAdmin && (
        <>
          <p className="mb-2 text-xs text-ink-muted">
            Beam-search LM - must be index-parallel to this model's vocab. Leave empty to decode
            via AR-decoder rescoring instead.
          </p>
          <label className="mb-1 block text-sm font-medium text-ink" htmlFor="model-lm">
            KenLM binary (backend path)
          </label>
          <Input size="md" id="model-lm" value={lmPath} onChange={(e) => setLmPath(e.target.value)}
                 placeholder="/models/lm/union_v3.bin" className="mb-3 w-full font-mono" />
          <label className="mb-1 block text-sm font-medium text-ink" htmlFor="model-lm-dict">
            LM dictionary (backend path)
          </label>
          <Input size="md" id="model-lm-dict" value={lmDictPath} onChange={(e) => setLmDictPath(e.target.value)}
                 placeholder="/models/lm/union_v3.dict" className="mb-4 w-full font-mono" />
        </>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button disabled={busy || !name.trim()} onClick={save} className={`${modalPrimaryBtn} disabled:opacity-40`}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
