/**
 * RFC-028 D8 mod-picker PROBE (step 0). `/take` opens a focused pane with a `Select` of the threads this
 * session could take; picking one calls the einweave MCP server's own `take` tool -- no model turn.
 *
 * It asks the tools what they already answer: `list_threads(takeable)` numbers the list and the plugin
 * remembers it, so the Select's values are those numbers and `take(ref: N)` acts on the id behind them.
 */
import type { Register } from 'claude-code'

const PANE = 'einweave-take'
const SERVER = 'einweave'

/** "1. #general · Fix the build — unheld, ..." lines of the numbered list -> Select options. */
export function parseOptions(text: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (const line of text.split('\n')) {
    const m = /^(\d{1,3})\. (.+)$/.exec(line)
    if (m) out.push({ value: m[1]!, label: `${m[1]}. ${m[2]!.slice(0, 100)}` })
  }
  return out
}

const textOf = (r: { content: readonly { type: string; text?: string }[] }): string => r.content.map(c => (c.type === 'text' ? (c.text ?? '') : '')).join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'take', description: 'Pick a thread to take for this session' })
    return next(e)
  })

  on('command.run', { command: 'take' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Take a thread', focus: true, closeOnEscape: true })
    return { text: opened.isPlaced ? '' : 'Widen the terminal, or use /einweave:take.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const listed = await $.mcp.call(SERVER, 'list_threads', { takeable: true, limit: 20 })
    const options = parseOptions(textOf(listed))
    if (listed.isError || options.length === 0) return <Text dimColor>{options.length === 0 && !listed.isError ? 'No threads to take.' : textOf(listed)}</Text>
    return (
      <Box flexDirection="column">
        <Select
          key="pick"
          label="Take"
          autoFocus
          options={options}
          onSelect={async value => {
            const res = await $.mcp.call(SERVER, 'take', { ref: value })
            $.ui.toast(textOf(res).split('\n')[0] ?? 'done')
            await $.ui.close({ id: PANE })
          }}
        />
      </Box>
    )
  })
}
