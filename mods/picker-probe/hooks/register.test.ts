import { test, expect } from 'claude-code/testing'
import { parseOptions } from './register'

const LIST = Array.from({ length: 20 }, (_, i) => `${i + 1}. #general · Thread number ${i + 1} — unheld, addressed to you`).join('\n')

test('parseOptions turns the numbered list into Select options', () => {
  const o = parseOptions(`Threads this session could take:\n${LIST}\nMore: x`)
  expect(o.length).toBe(20)
  expect(o[19]!.value).toBe('20')
})

test('/take registers, opens a focused pane, draws a 20-option Select, and a pick calls the take tool', async ($, on) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('mcp.call', async (_$, e) => {
    calls.push({ tool: e.tool, args: e.args })
    return { value: { content: [{ type: 'text', text: e.tool === 'list_threads' ? LIST : 'This session now holds Thread number 7.' }], isError: false } }
  })
  const registered: string[] = []
  on('command.register', async (_$, e) => { registered.push(e.name); return { value: { command: e.name } } })
  on('session.start', async () => ({ cwd: '/tmp' }) as any)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp', source: 'startup' } as any)
  expect(registered).toEqual(['take'])
  const run = await $.command.run({ command: 'take', args: '' })
  expect(run).toBeDefined()
  for (const surface of ['terminal', 'desktop'] as const) {
    const m = await $.ui.mount({ plugin: 'einweave-picker-probe', surface, component: 'Pane', requestId: 'einweave-take', props: {} } as any)
    const sel = (m as any).find({ key: 'pick' })
    expect(sel).toBeDefined()
    await $.ui.select({ plugin: 'einweave-picker-probe', key: 'pick', value: '7' })
    await (m as any).unmount()
  }
  expect(calls.some(c => c.tool === 'list_threads' && c.args.takeable === true)).toBe(true)
  expect(calls.some(c => c.tool === 'take' && c.args.ref === '7')).toBe(true)
})
