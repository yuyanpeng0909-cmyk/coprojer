const { fs, assert, sandbox, fixture, load } = require('./fixtures/verification-runtime.cjs')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const { readContext } = load('src/main/engineering/context.ts')
const { requirementsPreparation, requirePrd } = load('src/shared/prototype-workflow.ts')
async function main() {
  const ctx = fixture()
  ctx.feature.stage = 'requirements'
  ctx.project.prototypes = [{ id: 'approved', title: '长原型', html: '<html>' + '长原型交互内容'.repeat(14000) + '</html>', at: new Date().toISOString() }]
  ctx.service.selectPrototype('p', 'approved')
  const readOffsets = []
  const server = await provider(req => {
    const messages = req.body.messages
    const prompt = messages.find(m => m.role === 'system').content
    const marker = '必读资料进度：'
    const progressLine = prompt.split('\n').find(line => line.startsWith(marker))
    const progress = progressLine ? JSON.parse(progressLine.slice(marker.length))[0] : null
    // Model follows the current host cursor. Without it, archived tool pages
    // disappear from its visible history and it starts those pages again.
    let offset = progress?.nextOffset ?? 0
    if (!progress) {
      const pages = messages.filter(m => m.role === 'tool').flatMap(m => {
        try { const p = JSON.parse(m.content); return Number.isInteger(p.offset) ? [p] : [] } catch { return [] }
      }).sort((a, b) => a.offset - b.offset)
      for (const p of pages) if (p.offset <= offset) offset = Math.max(offset, p.offset + p.content.length)
    }
    if (progress?.complete) return { text: JSON.stringify({ document: '# PRD\n根据已确认原型整理的交互与验收。', features: [ctx.feature] }), calls: [] }
    const total = JSON.parse(readContext(ctx.project, { id: 'prototype:approved' })).totalCharacters
    const calls = []
    for (let i = 0; i < 3 && offset < total; i++, offset += 6000) {
      readOffsets.push(offset)
      calls.push({ id: 'read-' + readOffsets.length, name: 'read_context', arguments: JSON.stringify({ id: 'prototype:approved', offset, ...(progress?.version ? { version: progress.version } : {}) }) })
    }
    return { text: '', calls }
  })
  try {
    ctx.service.store.data.models[0].baseUrl = server.url
    await ctx.service.preparePrd('p')
    assert.equal(ctx.project.prd.status, 'review')
    assert.equal(ctx.project.prototypeBriefs[''].status, 'accepted')
    assert.ok(ctx.project.events.some(e => e.kind === 'context-compaction'), 'must exercise compaction')
    assert.equal(new Set(readOffsets).size, readOffsets.length, 'must continue from unread page after compaction')
    assert.deepEqual(server.errors, [])
    assert.equal(requirementsPreparation(ctx.project), 'ready')
    for (const status of ['error', 'stale', 'generating', 'missing']) {
      const copy = structuredClone(ctx.project)
      if (status === 'missing') delete copy.prd
      else copy.prd.status = status
      const before = JSON.stringify(copy)
      assert.equal(requirementsPreparation(copy), status === 'generating' ? 'generating' : status === 'missing' ? 'prototype' : 'prd')
      assert.equal(JSON.stringify(copy), before, 'UI preparation must not mutate persisted state')
      assert.throws(() => requirePrd(copy), /PRD/)
    }
    const mismatch = structuredClone(ctx.project)
    mismatch.prd.sources[0].prototypeId = 'different'
    assert.equal(requirementsPreparation(mismatch), 'prd')
    assert.throws(() => requirePrd(mismatch), /PRD/)
    const changed = structuredClone(ctx.project)
    changed.features[0].description += '新增业务范围'
    const before = JSON.stringify(changed)
    assert.equal(requirementsPreparation(changed), 'prototype')
    assert.equal(JSON.stringify(changed), before)
    console.log('PASS: long approved prototype read across compaction without restarting; PRD ready for human review')
  } finally { await server.close(); fs.rmSync(sandbox, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
