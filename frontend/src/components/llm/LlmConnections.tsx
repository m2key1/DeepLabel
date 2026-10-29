import { useCallback, useEffect, useState } from 'react'
import {
  createLlmConnection, createLlmModel, deleteLlmConnection, deleteLlmModel, getLlmPrompt,
  getLlmSettings, patchLlmConnection, patchLlmModel, probeLlmConnection, putLlmPrompt,
  type LlmConnection, type LlmModel, type LlmSettings,
} from '../../api'
import { useAuth } from '../../auth'
import { Badge } from '../ui/Badge'
import { Button, Toggle } from '../ui/Button'
import { useAutoClear } from '../../messages'
import { Input, Textarea } from '../ui/Field'
import { Section } from '../ui/Section'
import { LlmReferences } from './LlmReferences'
import { VisibilityBadge } from './VisibilityBadge'


const noticeClass = 'rounded border border-warn/40 bg-warn/10 p-3 text-xs text-warn'

interface Refresh {
  refresh: () => void
  fail: (error: unknown) => void
}

function ModelRow({ model, editable, shared, inherited, refresh, fail }:
Refresh & { model: LlmModel; editable: boolean; shared: boolean; inherited: string }) {
  const [openPrompt, setOpenPrompt] = useState(false)
  const [prompt, setPrompt] = useState(model.prompt)
  const [edge, setEdge] = useState(String(model.max_image_edge))
  const [tokens, setTokens] = useState(model.max_tokens === null ? '' : String(model.max_tokens))
  const [extra, setExtra] = useState(model.extra_body === '{}' ? '' : model.extra_body)
  const [atOnce, setAtOnce] = useState(
    model.max_concurrency === null ? '' : String(model.max_concurrency))

  const save = async () => {
    try {
      await patchLlmModel(model.id, {
        prompt,
        max_image_edge: Number(edge),
        max_tokens: tokens.trim() ? Number(tokens) : null,
        max_concurrency: atOnce.trim() ? Number(atOnce) : null,
        extra_body: extra.trim() || '{}',
      })
      setOpenPrompt(false)
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  const toggle = async () => {
    try {
      await patchLlmModel(model.id, { enabled: !model.enabled })
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  const remove = async () => {
    if (!confirm(`Remove "${model.label}"? Datasets set to read with it stop using it.`)) return
    try {
      await deleteLlmModel(model.id)
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  return (
    <div data-testid="llm-model" data-label={model.label} data-enabled={model.enabled}
         className="border-t border-line py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{model.label}</span>
        <VisibilityBadge shared={shared} />
        <code className="text-xs text-ink-muted">{model.model}</code>
        <span className="text-xs text-ink-subtle">{model.max_image_edge}px</span>
        <div className="ml-auto flex items-center gap-1.5">
          {editable && (
            <>
              <Toggle on={model.enabled} onClick={toggle} data-testid="llm-model-toggle">
                {model.enabled ? 'Enabled' : 'Disabled'}
              </Toggle>
              <Button size="xs" onClick={() => setOpenPrompt(!openPrompt)} data-testid="llm-model-edit">
                Prompt
              </Button>
              <Button size="xs" variant="danger" onClick={remove} data-testid="llm-model-delete">
                Remove
              </Button>
            </>
          )}
        </div>
      </div>
      {openPrompt && (
        <div className="mt-2 space-y-2">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={8}
            placeholder={inherited}
            aria-label={`Prompt for ${model.label}`}
            data-testid="llm-prompt"
            className="w-full font-mono text-xs"
          />
          <p className="text-xs text-ink-muted">
            {prompt.trim() ? 'Its own wording.' : 'Follows your default.'}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-ink-muted">
              Longest image edge
              <Input
                value={edge}
                onChange={(e) => setEdge(e.target.value)}
                aria-label={`Longest image edge for ${model.label}`}
                data-testid="llm-model-edge"
                className="ml-2 w-24"
              />
            </label>
            <label className="text-xs text-ink-muted">
              Token ceiling
              <Input
                value={tokens}
                onChange={(e) => setTokens(e.target.value)}
                placeholder="the endpoint's"
                aria-label={`Token ceiling for ${model.label}`}
                data-testid="llm-model-tokens"
                className="ml-2 w-32"
              />
            </label>
            <label className="text-xs text-ink-muted"
                   title="How many pages may be out with this model at once. Empty lets it use every slot the worker has; a provider that rate-limits wants fewer.">
              Pages at once
              <Input
                value={atOnce}
                onChange={(e) => setAtOnce(e.target.value)}
                placeholder="every slot"
                aria-label={`Pages at once for ${model.label}`}
                data-testid="llm-model-concurrency"
                className="ml-2 w-28"
              />
            </label>
          </div>
          <label className="block text-xs text-ink-muted">
            Extra request fields
            <Textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={2}
              placeholder='{"chat_template_kwargs": {"enable_thinking": false}}'
              aria-label={`Extra request fields for ${model.label}`}
              data-testid="llm-model-extra"
              className="mt-1 w-full font-mono text-xs"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="primary" onClick={save} data-testid="llm-prompt-save">
              Save
            </Button>
          </div>
          <p className="text-xs text-ink-muted">
            1600px is the cached rendition; higher costs a larger upload. Extra fields are merged
            into the request - a reasoning model needs thinking turned off here.
          </p>
        </div>
      )}
    </div>
  )
}

function AddModel({ connection, refresh, fail }: Refresh & { connection: LlmConnection }) {
  const [model, setModel] = useState('')
  const [label, setLabel] = useState('')
  const [offered, setOffered] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const probe = async () => {
    setBusy(true)
    try {
      setOffered((await probeLlmConnection(connection.id)).models)
    } catch (error) {
      setOffered(null)
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    try {
      await createLlmModel(connection.id, { model: model.trim(), label: label.trim() || undefined })
      setModel('')
      setLabel('')
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        value={model}
        onChange={(e) => setModel(e.target.value)}
        list={`llm-offered-${connection.id}`}
        placeholder="Model id"
        aria-label="Model id"
        data-testid="llm-model-id"
        className="w-48"
      />
      {offered && (
        <datalist id={`llm-offered-${connection.id}`} data-testid="llm-offered">
          {offered.map((id) => <option key={id} value={id} />)}
        </datalist>
      )}
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Name it (optional)"
        aria-label="Model name"
        data-testid="llm-model-label"
        className="w-48"
      />
      <Button size="xs" onClick={add} disabled={!model.trim()} data-testid="llm-add-model">
        Add model
      </Button>
      <Button size="xs" variant="ghost" onClick={probe} disabled={busy} data-testid="llm-probe">
        {busy ? 'Asking…' : 'Ask what it offers'}
      </Button>
      {offered && (
        <span className="text-xs text-ink-muted" data-testid="llm-probe-result">
          {offered.length} model{offered.length === 1 ? '' : 's'} offered
        </span>
      )}
    </div>
  )
}

function ConnectionCard({ connection, secretConfigured, inherited, refresh, fail }:
Refresh & { connection: LlmConnection; secretConfigured: boolean; inherited: string }) {
  const { isAdmin } = useAuth()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(connection.name)
  const [baseUrl, setBaseUrl] = useState(connection.base_url)
  const [apiKey, setApiKey] = useState('')

  const save = async () => {
    try {
      await patchLlmConnection(connection.id, {
        name, base_url: baseUrl, ...(apiKey ? { api_key: apiKey } : {}),
      })
      setApiKey('')
      setEditing(false)
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  const clearKey = async () => {
    try {
      await patchLlmConnection(connection.id, { api_key: null })
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  const publish = async () => {
    try {
      await patchLlmConnection(connection.id, { shared: !connection.shared })
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  const markSelfHosted = async () => {
    try {
      await patchLlmConnection(connection.id, { self_hosted: !connection.self_hosted })
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete "${connection.name}" and its models?`)) return
    try {
      await deleteLlmConnection(connection.id)
      refresh()
    } catch (error) {
      fail(error)
    }
  }

  return (
    <div data-testid="llm-connection" data-name={connection.name} data-shared={connection.shared}
         className="mb-3 rounded border border-line p-3">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Connection name"
                 data-testid="llm-edit-name" className="w-40" />
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Base URL"
                 data-testid="llm-edit-url" className="flex-1 min-w-56" />
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password"
                 placeholder={connection.has_key ? 'Leave blank to keep the key' : 'API key (optional)'}
                 aria-label="API key" data-testid="llm-edit-key" className="w-56" />
          <Button size="xs" variant="primary" onClick={save} data-testid="llm-save">Save</Button>
          <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2" data-testid="llm-connection-head">
          <span className="font-medium">{connection.name}</span>
          <VisibilityBadge shared={connection.shared} />
          {connection.self_hosted && <Badge tone="accent" data-testid="llm-self-hosted">self-hosted</Badge>}
          {connection.shared && (
            <span data-testid="llm-owner" className="text-xs text-ink-muted">
              published by {connection.owner}
            </span>
          )}
          <code className="text-xs text-ink-muted">{connection.base_url}</code>
          <span className="text-xs text-ink-muted" data-testid="llm-key-state">
            {connection.has_key ? `key …${connection.key_hint}` : 'no key'}
          </span>
          {isAdmin && (
            <Toggle
              on={connection.self_hosted}
              onClick={markSelfHosted}
              data-testid="llm-mark-self-hosted"
              className="ml-auto"
              title="Admins only. A self-hosted endpoint runs in-house, so datasets that keep their pages from external LLM providers may still be read with it."
            >
              Self-hosted
            </Toggle>
          )}
          {connection.editable && (
            <div className={`${isAdmin ? '' : 'ml-auto '}flex items-center gap-1.5`}>
              {connection.has_key && (
                <Button size="xs" onClick={clearKey} data-testid="llm-clear-key">Clear key</Button>
              )}
              <Button size="xs" onClick={() => setEditing(true)} data-testid="llm-edit">Edit</Button>
              {isAdmin && (
                <Toggle
                  on={connection.shared}
                  onClick={publish}
                  data-testid="llm-publish"
                  title={connection.shared
                    ? 'Admins only. Everyone can read with these models, and every call is billed to your key. Unpublish to keep it to yourself.'
                    : 'Admins only. Publishing shows this endpoint to everyone on this deployment and lets them read with it - against your key. Nobody but you can edit it.'}
                >
                  {connection.shared ? 'Published to everyone' : 'Publish to everyone'}
                </Toggle>
              )}
              <Button size="xs" variant="danger" onClick={remove} data-testid="llm-delete">Delete</Button>
            </div>
          )}
        </div>
      )}

      <div className="mt-2">
        {connection.models.length === 0 ? (
          <p className="text-xs text-ink-muted">No models yet.</p>
        ) : (
          connection.models.map((model) => (
            <ModelRow key={model.id} model={model} editable={connection.editable}
                      shared={connection.shared} inherited={inherited} refresh={refresh} fail={fail} />
          ))
        )}
        {connection.editable && <AddModel connection={connection} refresh={refresh} fail={fail} />}
      </div>

      {connection.editable && !secretConfigured && !connection.has_key && (
        <p className="mt-2 text-xs text-ink-muted" data-testid="llm-no-secret">
          No LLM_SECRET_KEY on this backend, so a key cannot be stored. Keyless endpoints work.
        </p>
      )}
    </div>
  )
}

export function LlmConnections() {
  const [settings, setSettings] = useState<LlmSettings | null>(null)
  const [shipped, setShipped] = useState('')
  const [personal, setPersonal] = useState('')
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const refresh = useCallback(() => {
    getLlmSettings().then(setSettings).catch((e: Error) => setError(e.message))
    getLlmPrompt()
      .then((r) => {
        setShipped(r.default)
        setPersonal(r.prompt)
      })
      .catch(() => undefined)
  }, [])

  useEffect(refresh, [refresh])

  const fail = (e: unknown) => setError((e as Error).message)

  const savePrompt = async () => {
    setError(null)
    try {
      const saved = await putLlmPrompt(promptDraft ?? '')
      setPersonal(saved.prompt)
      setPromptDraft(null)
      refresh()
    } catch (e) {
      fail(e)
    }
  }

  const resetPrompt = async () => {
    setError(null)
    try {
      setPersonal((await putLlmPrompt('')).prompt)
      setPromptDraft(null)
      refresh()
    } catch (e) {
      fail(e)
    }
  }

  const add = async () => {
    setError(null)
    try {
      await createLlmConnection({
        name: name.trim(), base_url: baseUrl.trim(), api_key: apiKey.trim() || null,
      })
      setName('')
      setBaseUrl('')
      setApiKey('')
      refresh()
    } catch (e) {
      fail(e)
    }
  }

  if (!settings) return null

  // What a model with no wording of its own is asked with, shown as its placeholder.
  const inherited = personal || shipped

  return (
    <Section
      title="Language models for pre-annotation"
      className="mb-0"
      data-testid="llm-connections"
      description="Any OpenAI-compatible endpoint. Yours alone until an admin publishes it; keys are
        encrypted and never sent back here. Runs are billed to whoever starts them."
    >

      <div className="mb-4 rounded border border-line p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Your default prompt</span>
          <span className="text-xs text-ink-muted">
            {personal ? 'your own wording' : 'the shipped wording'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {promptDraft === null ? (
              <Button size="xs" onClick={() => setPromptDraft(personal || shipped)}
                      data-testid="edit-default-prompt">
                Edit
              </Button>
            ) : (
              <>
                <Button size="xs" variant="primary" onClick={savePrompt}
                        data-testid="save-default-prompt">Save</Button>
                {personal && (
                  <Button size="xs" onClick={resetPrompt} data-testid="reset-default-prompt">
                    Back to shipped
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => setPromptDraft(null)}>Cancel</Button>
              </>
            )}
          </div>
        </div>
        {promptDraft === null ? (
          <pre data-testid="default-prompt"
               className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-muted">
            {personal || shipped}
          </pre>
        ) : (
          <Textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={10}
            aria-label="Your default prompt"
            data-testid="default-prompt-editor"
            className="w-full font-mono text-xs"
          />
        )}
        <p className="mt-1 text-xs text-ink-muted">
          Used by every model without its own wording, on your runs.
        </p>
      </div>

      <div className="mb-4 rounded border border-line p-3">
        <LlmReferences canEdit={settings.enabled} onError={setError} />
      </div>

      {!settings.enabled ? (
        <p className={noticeClass} data-testid="llm-disabled">
          Switched off on this deployment (ENABLE_LLM_OCR). Existing connections stay listed.
        </p>
      ) : (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it"
                 aria-label="Connection name" data-testid="llm-name" className="w-40" />
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                 placeholder="https://api.example.com/v1" aria-label="Base URL"
                 data-testid="llm-base-url" className="flex-1 min-w-56" />
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password"
                 placeholder="API key (optional)" aria-label="API key"
                 data-testid="llm-api-key" className="w-56" />
          <Button variant="primary" onClick={add} disabled={!name.trim() || !baseUrl.trim()}
                  data-testid="llm-add-connection">
            Add connection
          </Button>
        </div>
      )}

      {error && <p className="mb-2 text-sm text-danger" data-testid="llm-error">{error}</p>}

      {settings.connections.length === 0 ? (
        <p className="text-sm text-ink-muted">No connections yet.</p>
      ) : (
        settings.connections.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection}
                          secretConfigured={settings.secret_configured} inherited={inherited}
                          refresh={refresh} fail={fail} />
        ))
      )}
    </Section>
  )
}
