import { test, expect } from '../helpers/test'
import {
  BACKEND, LLM_BASE_URL, backendFetch, identity, llmSettings, llmStubModels, seedLlmConnection,
  uniqueName,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'

// Connections are personal, and the dev bypass logs the browser in as this account -
// so the backend oracle has to ask as the same person the UI saved as.
const DEV = identity('dev', 'admin')

const KEY = 'sk-e2e-provider-9911'

const connectionCard = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`[data-testid="llm-connection"][data-name="${name}"]`)

const visibility = (card: import('@playwright/test').Locator) =>
  card.getByTestId('llm-connection-head').getByTestId('llm-visibility')

test.describe('Scenario: registering language models for pre-annotation', () => {
  test('an endpoint is registered with its models, and the key never comes back', async ({ page }) => {
    const name = uniqueName('Stub provider')

    await page.goto('/settings?section=llm')
    await page.getByTestId('llm-name').fill(name)
    await page.getByTestId('llm-base-url').fill(LLM_BASE_URL)
    await page.getByTestId('llm-api-key').fill(KEY)
    await page.getByTestId('llm-add-connection').click()

    const card = connectionCard(page, name)
    await expect(card).toBeVisible()
    // Only the last characters of the key are ever shown - enough to tell two apart.
    await expect(card.getByTestId('llm-key-state')).toHaveText('key …9911')

    // The endpoint is asked what it serves, so the model id is picked rather than typed.
    const offered = await llmStubModels()
    await card.getByTestId('llm-probe').click()
    await expect(card.getByTestId('llm-probe-result')).toHaveText(`${offered.length} models offered`)
    await expect(card.getByTestId('llm-offered').locator('option')).toHaveCount(offered.length)
    await expect(card.getByTestId('llm-offered').locator('option').first())
      .toHaveAttribute('value', offered[0])

    await card.getByTestId('llm-model-id').fill('stub-perfect')
    await card.getByTestId('llm-model-label').fill('Careful reader')
    await card.getByTestId('llm-add-model').click()
    await expect(card.locator('[data-testid="llm-model"][data-label="Careful reader"]')).toBeVisible()

    // Backend oracle: the row is exactly what was entered, and the key is not in it.
    const saved = (await llmSettings(DEV)).connections.find((c) => c.name === name)!
    expect(saved).toMatchObject({
      owner: 'dev', base_url: LLM_BASE_URL, has_key: true, key_hint: '9911',
      shared: false, editable: true,
    })
    expect(Object.keys(saved)).not.toContain('api_key')
    expect(saved.models).toHaveLength(1)
    expect(saved.models[0]).toMatchObject({
      model: 'stub-perfect', label: 'Careful reader', max_image_edge: 1600,
      temperature: 0, enabled: true,
    })
    // No wording of its own, so it follows whoever runs it - which is the shipped prompt
    // here, the one thing keeping a model from modernising the text.
    expect(saved.models[0].prompt).toBe('')
    const mine = await backendFetch('/api/llm/prompt', { headers: DEV })
    expect(mine.prompt).toBe('')
    expect(mine.default).toContain('Never modernise')
    expect(mine.default).toContain('Never expand them')
  })

  test('the prompt and image size are the per-model knobs, and both persist', async ({ page }) => {
    const name = uniqueName('Tunable provider')
    await seedLlmConnection(name, ['stub-perfect'], DEV)

    await page.goto('/settings?section=llm')
    const card = connectionCard(page, name)
    const row = card.locator(`[data-testid="llm-model"][data-label="${name} stub-perfect"]`)
    await row.getByTestId('llm-model-edit').click()
    await row.getByTestId('llm-prompt').fill('Transcribe verbatim. Kurrent script, 18th century.')
    await row.getByTestId('llm-model-edge').fill('2400')
    await row.getByTestId('llm-prompt-save').click()

    await expect.poll(async () => {
      const saved = (await llmSettings(DEV)).connections.find((c) => c.name === name)!
      return saved.models[0]
    }).toMatchObject({
      prompt: 'Transcribe verbatim. Kurrent script, 18th century.',
      max_image_edge: 2400,
    })

    // Disabling keeps the model but takes it out of what a dataset can be read with.
    await row.getByTestId('llm-model-toggle').click()
    await expect(row).toHaveAttribute('data-enabled', 'false')
    await expect.poll(async () =>
      (await llmSettings(DEV)).connections.find((c) => c.name === name)!.models[0].enabled,
    ).toBe(false)
  })

  test('a connection is invisible to a colleague until an admin publishes it', async ({ page }) => {
    const privateName = uniqueName('Private endpoint')
    const publishedName = uniqueName('House endpoint')
    await seedLlmConnection(privateName, ['stub-perfect'], DEV)
    const published = await seedLlmConnection(publishedName, ['stub-typo'], DEV)

    await page.goto('/settings?section=llm')
    // Both are the admin's own, so both are editable here - the presence side of the
    // absence assertions below.
    await expect(connectionCard(page, privateName).getByTestId('llm-edit')).toBeVisible()
    await expect(connectionCard(page, publishedName).getByTestId('llm-edit')).toBeVisible()
    await expect(visibility(connectionCard(page, publishedName))).toHaveText('Private')

    // Publishing is the admin's to do, and says so - the presence side of the member's
    // missing control below.
    const publish = connectionCard(page, publishedName).getByTestId('llm-publish')
    await expect(publish).toHaveText('Publish to everyone')
    await expect(publish).toHaveAttribute('title', /^Admins only\./)
    await publish.click()
    await expect(connectionCard(page, publishedName)).toHaveAttribute('data-shared', 'true')
    await expect(visibility(connectionCard(page, publishedName))).toHaveText('Public')
    await expect(visibility(connectionCard(page, privateName))).toHaveText('Private')
    await expect(publish).toHaveText('Published to everyone')
    await expect.poll(async () =>
      (await llmSettings(DEV)).connections.find((c) => c.name === publishedName)!.shared,
    ).toBe(true)

    const colleague = `member-${Date.now()}`
    const theirOwnName = uniqueName('Their endpoint')
    await seedLlmConnection(theirOwnName, ['stub-perfect'], identity(colleague, 'member'))
    await useSession(page.context(), seedSession('member', colleague))
    await page.goto('/settings?section=llm')

    // The published one is there, read-only; the private one does not exist for them.
    const house = connectionCard(page, publishedName)
    await expect(house).toBeVisible()
    await expect(visibility(house)).toHaveText('Public')
    await expect(house.getByTestId('llm-owner')).toHaveText('published by dev')
    await expect(house.getByTestId('llm-model').getByTestId('llm-visibility')).toHaveText('Public')
    await expect(house.getByTestId('llm-edit')).toHaveCount(0)
    await expect(connectionCard(page, privateName)).toHaveCount(0)

    // Their own is theirs to edit but not to publish: only an admin makes one public.
    const own = connectionCard(page, theirOwnName)
    await expect(visibility(own)).toHaveText('Private')
    await expect(own.getByTestId('llm-model').getByTestId('llm-visibility')).toHaveText('Private')
    await expect(own.getByTestId('llm-edit')).toBeVisible()
    await expect(own.getByTestId('llm-publish')).toHaveCount(0)

    // The backend agrees, and refuses the write the UI never offers.
    // Published connections are instance-wide, so this asks about these two by name
    // rather than about the whole list.
    const theirs = (await llmSettings(identity(colleague, 'member'))).connections
    expect(theirs.map((c) => c.name)).toContain(publishedName)
    expect(theirs.map((c) => c.name)).not.toContain(privateName)
    expect(theirs.find((c) => c.name === publishedName)!.editable).toBe(false)

    const refused = await fetch(`${BACKEND}/api/llm/connections/${published.id}`, {
      method: 'PATCH',
      headers: {
        'X-Frontend-Secret': 'e2e-secret',
        'Content-Type': 'application/json',
        ...identity(colleague, 'member'),
      },
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    expect(refused.status).toBe(403)
  })

  test('an endpoint that cannot be reached says so instead of failing silently', async ({ page }) => {
    const name = uniqueName('Wrong path')
    await seedLlmConnection(name, [], DEV)

    await page.goto('/settings?section=llm')
    const card = connectionCard(page, name)
    // Point it somewhere the stub does not serve, then ask what it offers.
    await card.getByTestId('llm-edit').click()
    await card.getByTestId('llm-edit-url').fill('http://llm:8000/nowhere')
    await card.getByTestId('llm-save').click()
    // The form closes once the save has landed; probing before that asks the old address.
    await expect(card.getByTestId('llm-edit-url')).toHaveCount(0)
    await card.getByTestId('llm-probe').click()

    // A fixed sentence from the status alone. The stub's body names the path it was
    // asked for, and any address may be probed, so none of it is repeated.
    await expect(page.getByTestId('llm-error'))
      .toHaveText('the endpoint answered 404 - check the address ends at /v1')
    await expect(card.getByTestId('llm-probe-result')).toHaveCount(0)

    // And it clears itself: a failure you have already read and acted on should not sit
    // there for the rest of the session.
    await expect(page.getByTestId('llm-error')).toHaveCount(0, { timeout: 20_000 })
  })
})
