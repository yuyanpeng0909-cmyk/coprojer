const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { startRoundtableProvider } = require('./fixtures/roundtable-provider.cjs')

;(async () => {
  const output = path.resolve('output/playwright')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'budget-profile-'))
  const parent = await fs.mkdtemp(path.join(output, 'budget-project-'))
  const provider = await startRoundtableProvider()
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let app
  try {
    app = await electron.launch({ args: ['.'], env })
    let page = await app.firstWindow()
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    const call = (method, ...args) =>
      page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), {
        method,
        args,
      })
    const models = []
    for (const name of ['产品模型', '架构模型'])
      models.push(
        await call('saveModel', {
          id: '',
          name,
          model: name,
          baseUrl: provider.baseUrl,
          protocol: name === '产品模型' ? 'responses' : 'chat',
          apiKey: '',
        }),
      )
    const config = {
      participants: models.map((m, i) => ({ modelId: m.id, role: i ? '评审' : '主持' })),
      passes: 1,
    }
    const project = async (id) => (await call('state')).projects.find((p) => p.id === id)
    async function finish(id, answer = true) {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const p = await project(id)
        if (!p.activity) return p
        const pending = p.decisions?.find((d) => d.status === 'pending')
        if (answer && pending)
          await call(
            'answerDecision',
            id,
            pending.id,
            pending.question.includes('第 17 步') ? { defer: true } : { choice: 0 },
          )
        await new Promise((r) => setTimeout(r, 30))
      }
      throw Error('Discussion did not finish')
    }
    for (const mode of ['long', 'reserved', 'endless', 'errors']) {
      provider.control.decisions = mode
      const id = await call('createProject', {
        name: `预算回归-${mode}`,
        brief: '逐步讨论需求',
        parent,
        modelId: models[0].id,
      })
      const start = provider.control.requests.length
      await call('roundtableTurn', id, '持续更新并及时向人工提问。', config)
      const p = await finish(id)
      assert.equal(p.roundtable.status, 'awaiting-human', `${mode}: ${p.roundtable.error}`)
      assert.ok(!p.chat.some((c) => c.error?.includes('已达上限')))
      if (mode === 'long') {
        assert.equal(
          p.decisions.length,
          4,
          'All human turns must continue past the old ten-step cap',
        )
        assert.equal(p.decisions.filter((d) => d.status === 'deferred').length, 1)
      }
      if (mode === 'reserved') {
        assert.equal(p.decisions.length, 1)
        assert.deepEqual(
          p.decisions[0].options.map((o) => o.label),
          ['仅在线'],
        )
        assert.ok(!p.chat.some((c) => c.tools?.some((t) => t.status === 'error')))
      }
      if (['endless', 'errors'].includes(mode)) {
        const requests = provider.control.requests
          .slice(start)
          .filter((r) => r.model === '产品模型' && !r.instructions.includes('你是本轮圆桌主持人'))
        assert.ok(
          requests.length <= (mode === 'errors' ? 4 : 33),
          'Autonomous retries must stay bounded',
        )
        assert.ok(
          !requests.at(-1).tools?.length,
          'Last request must summarize without further tool execution',
        )
      }
    }
    // Resume at the failing second participant, including after a desktop restart.
    provider.control.decisions = ''
    const id = await call('createProject', {
      name: '断点续接',
      brief: '保留发言游标',
      parent,
      modelId: models[0].id,
    })
    provider.control.failModel = '架构模型'
    await call('roundtableTurn', id, '开始讨论', config)
    const failed = await finish(id)
    assert.equal(failed.roundtable.status, 'error')
    assert.equal(failed.roundtable.cursor, 1)
    await app.close()
    app = await electron.launch({ args: ['.'], env })
    page = await app.firstWindow()
    await page.waitForFunction(() => !!window.desktop?.engineering)
    assert.equal((await project(id)).roundtable.cursor, 1)
    provider.control.failModel = ''
    const start = provider.control.requests.length
    await call('roundtableTurn', id, '继续此前的讨论', config)
    const resumed = await finish(id)
    assert.equal(resumed.roundtable.round, failed.roundtable.round)
    assert.equal(provider.control.requests[start].model, '架构模型')
    assert.equal(resumed.roundtable.status, 'awaiting-human')
    await call('roundtableTurn', id, '这一轮已结束，继续提出新反馈。', config)
    assert.equal((await finish(id)).roundtable.round, failed.roundtable.round + 1)
    console.log(
      'PASS: long human-in-the-loop discussions, reserved defer option, bounded summary, same-round cursor resume',
    )
  } finally {
    if (app) await app.close()
    await provider.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
