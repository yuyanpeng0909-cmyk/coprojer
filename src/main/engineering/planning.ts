import { complete, parseJson, type Connection, type ModelMessage, type ModelReply } from './model'
import type { DeltaListener } from './stream'
import { engineeringTools, listFiles, safePath } from './files'
import { readFileSync, statSync } from 'node:fs'
import { boundMessages, readContext, readPage } from './context'
import type { Project } from '../../shared/engineering'

export async function completeWithContext(connection: Connection, system: string, messages: ModelMessage[], project: Project, signal: AbortSignal, listener?: DeltaListener, requiredContextIds: string[] = [], readSkill?: (args: Record<string, any>) => string): Promise<ModelReply> {
  const tools = engineeringTools.filter(t => ['read_context', 'list_files', 'read_file', ...(readSkill ? ['read_skill'] : [])].includes(t.name))
  const coverage = new Map(requiredContextIds.map(id => [id, { read: 0, total: Infinity }]))
  for (let step = 0; step < 12; step++) {
    boundMessages(messages)
    const reply = await complete(connection, system, messages, tools, signal, listener)
    signal.throwIfAborted()
    if (!reply.calls.length) {
      if ([...coverage.values()].some(c => c.read < c.total)) throw new Error('未完整读取已确认原型，不能继续生成；请重试。')
      return reply
    }
    messages.push({ role: 'assistant', content: reply.text, calls: reply.calls, reasoning: reply.reasoning, responseItems: reply.responseItems, anthropicBlocks: reply.anthropicBlocks })
    for (const call of reply.calls) {
      let content: string
      try {
        const args = parseJson(call.arguments)
        if (call.name === 'read_skill' && readSkill) content = readSkill(args)
        else if (call.name === 'read_context') {
          content = readContext(project, args)
          const tracked = coverage.get(args.id)
          if (tracked) {
            const page = JSON.parse(content)
            tracked.total = page.totalCharacters
            if (page.offset <= tracked.read) tracked.read = Math.max(tracked.read, page.offset + page.content.length)
          }
        }
        else if (call.name === 'list_files') content = JSON.stringify(listFiles(project.root))
        else if (call.name === 'read_file') {
          const path = safePath(project.root, args.path)
          if (statSync(path).size > 400000) throw new Error('文件过大，请拆分文件。')
          content = readPage(readFileSync(path, 'utf8'), args)
        } else throw new Error('规划与原型阶段只提供读取工具。')
      } catch (error) { content = '工具错误：' + String(error) }
      messages.push({ role: 'tool', callId: call.id, content })
    }
  }
  throw new Error('读取资料达到 12 轮上限，请缩小范围后重试。')
}
