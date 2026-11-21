import { assert, mockEditorHost, test } from 'orca/testing'
import { CONFLICT_OUTSIDE } from './merge'
import { start } from './sync'

test('an agent edit and a pending edit on different lines both survive', async () => {
  const host = mockEditorHost({ text: '\\section{A}\nOne.\n\nTwo.\n' })
  const doc = await start()
  doc.change('\\section{A}\nOne.\n\nTwo, typed.\n')
  host.replace('\\section{Agent}\nOne.\n\nTwo.\n') // lands while the edit waits
  await host.flush()
  assert.equal(host.text, '\\section{Agent}\nOne.\n\nTwo, typed.\n')
  doc.dispose()
  host.dispose()
})

test('an outside write on the same line keeps both versions', async () => {
  const host = mockEditorHost({ text: 'x\nsame\ny' })
  const doc = await start()
  doc.change('x\nmine\ny')
  host.replace('x\ntheirs\ny')
  await host.flush()
  assert.ok((host.text ?? '').includes(CONFLICT_OUTSIDE))
  assert.ok((host.text ?? '').includes('theirs') && (host.text ?? '').includes('mine'))
  doc.dispose()
  host.dispose()
})

test('a read-only file is reported', async () => {
  const host = mockEditorHost({ text: 'x' }, { readOnly: true })
  const doc = await start()
  assert.equal(doc.readOnly, true)
  doc.dispose()
  host.dispose()
})
