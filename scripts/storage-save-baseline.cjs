// Controlled local measurements of the current durable store, without product changes.
const { fs, path, assert, sandbox, fixture, load, answer, call, testScript, restoreIsolated } = require('./fixtures/verification-runtime.cjs')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const ts = require('typescript')
const budget = load('src/main/engineering/runtime-budget.ts')
const output = path.resolve('.runtime/harness-refactor/storage-baseline')
const key = JSON.stringify(['p', 'f'])
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const done = () => answer({ status: 'incomplete', summary: '受控负载已执行，保留证据', nextStep: '人工核对测量结果' })
const tool = (name, args, id) => ({ id, name, arguments: JSON.stringify(args) })
const results = [], allRows = [], allReservations = [], reopenRows = [], eventSites = []
const eventLocationFailures = []
const eventAudit = [{"note":"output 回调只转发文本；命令效果在回调之后对账，未在回调内修改业务。","line":91,"file":"src/main/engineering/command-effects.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"output 回调只转发文本；changes 在 await runCommand 结束后的 finally 中更新并保存，不在该回调之前。","line":563,"file":"src/main/engineering/files.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"contextSession 事件转发回调无业务赋值；调用者的不同事件路径仍以动态摘要确认。","line":21,"file":"src/main/engineering/planning.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"contextSession 事件转发回调无本地业务赋值；不能据此断言整个请求期间没有捎带。","line":238,"file":"src/main/engineering/requirements.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"454 saveView 已提交讨论；deps.save 内 normalize/sync 后可能在保存或导出阶段失败，异常种类未限定，不能一概视为已保存。","line":455,"file":"src/main/engineering/requirements.ts","businessBefore":"未知","explicitSaveAfter":"否"},{"note":"454 saveView 与455 deps.save 已尝试完成；若455只导出失败则业务已保存，其他异常细节见上一行。此分支自身没有新增业务写入。","line":457,"file":"src/main/engineering/requirements.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"原型revision、brief状态、entry文本/推理/状态/designJob先修改；后进入 finally 补finishedAt/designActivity，再deps.save（610），不是紧跟保存。","line":595,"file":"src/main/engineering/requirements.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"finally 的finishedAt/designActivity已修改，deps.save可能保存失败或仅导出失败；无类型判断，不可断言均已落盘。","line":612,"file":"src/main/engineering/requirements.ts","businessBefore":"未知","explicitSaveAfter":"否"},{"note":"功能stage/scope/revision、requirementsBaseline、prd、context、roundtable均在本同步路径更新；下一句deps.save。","line":711,"file":"src/main/engineering/requirements.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"决定和chat在169已store.save；178 save可再次normalize/sync并在保存/导出任一阶段失败，此处新增规范化内容是否持久未知。","line":181,"file":"src/main/engineering/roundtable-decisions.ts","businessBefore":"未知","explicitSaveAfter":"否"},{"note":"p.prd、requirementsDocument、features已替换；下一句this.save(p)。","line":153,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"skillReader onRead回调本体仅写事件；agentInstructions的agentRuns在287已显式保存。","line":293,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"prototypeBriefs、selectedPrototypeIds、prd.status先修改；下一句this.save(p)。","line":347,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"功能阶段/scope/plan/tasks/revision以及chat先修改；下一句this.save(p)。","line":533,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"此catch只修改contextRuntime.status/reason，属设计单列的“上下文运行状态其余字段”，不是最后三类业务；其持久化归属未定，仍需保留记录。","line":616,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"initialize团队与data.projects.push先修改；下一句this.save(project)。","line":965,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"changes.length为真才记事件，说明name/pinned/archivedAt至少一个有改动；函数随后结束，无单独save。","line":1002,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"功能scope/prototypeId/stage/revision及context已修改；下一句this.save(p)。","line":1111,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"developerId/reviewerId/revision修改；下一句this.save(p)。","line":1130,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"生成结果plan/revision/tasks/planSource/错误字段修改；回调结束，beginResult.finally后续保存，非紧跟。","line":1161,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"stage及方案错误字段修改；下一句this.save(p)。","line":1196,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"批量项plan/revision/tasks/planSource/错误字段修改；随即return结果。","line":1223,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"feature.planGenerationError设为本次错误；随即return。","line":1234,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"Promise.allSettled后映射rejected项时可能新写feature.planGenerationError；已fulfilled项通常在各项event中保存。随后return，beginResult.finally后续保存。","line":1277,"file":"src/main/engineering/service.ts","businessBefore":"条件","explicitSaveAfter":"否"},{"note":"feature.planConfirmationError先写入；随即return。","line":1304,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"feature.planConfirmationError先写入；随即return。","line":1310,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"feature.stage及两个方案错误字段修改；随即return。","line":1319,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"feature.planConfirmationError先写入；随即return。","line":1325,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"rejected项映射可能写planConfirmationError；状态不为solution的fulfilled分支1296也写错误却未发事件。随后return，beginResult.finally后续保存。","line":1349,"file":"src/main/engineering/service.ts","businessBefore":"条件","explicitSaveAfter":"否"},{"note":"候选顺序/说明/解析结果均为局部变量，尚未写p.executionPlan；后续仅改局部messages并重试。","line":1432,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"p.executionPlan=plan；随后return，beginResult.finally后续保存，非紧跟。","line":1455,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"receivedReply只读取liveAgent并检查calls，无本地业务赋值。","line":1785,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"receivedReply只比较修订/合同；外部并发变更是否保存不由此回调判定。","line":1788,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"records.event本体仅转发；动态kind包含model/tool-result/报告等，不把所有种类固定为相同捎带结论。","line":1796,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"preparer对p.activity的写入在1857已store.save；其他角色本地仅算指纹和变量，没有未保存业务赋值。","line":1859,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"received修订失效分支只生成历史结果并抛出；没有本地业务赋值。","line":1963,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"state初始化/limit/fingerprint/environment和verificationPending已改；事件后才可能把attempt设interrupted，没有紧跟save。","line":2006,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"block闭包把preparation.phase/summary改为blocked；随后return。","line":2012,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"phase/gaps/summary与p.activity修改；下一步await agentLoop，非紧跟显式保存。","line":2021,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"round/attempts及phase/attempt.status/summary/activity修改；下一步await agentLoop。","line":2045,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"attempt结果/fingerprint/nextStep/status、preparation.phase/summary、feedback、verificationPending修改；随后return defect。","line":2060,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"attempt结果/status和preparation.phase/summary修改；随后return recheck。","line":2069,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"事件前只可能删除executionCheckpoints（设计单列检查点）；repairRound/results等业务赋值在事件之后。","line":2132,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"stage verifying、activity以及可选preparation.phase已改；随后计算验证输入并await agentLoop。","line":2168,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"本段改的是局部verification.commands和retainedFailures；f.verificationHistory/checks/results赋值在事件之后。agentLoop刚结束可能另有检查点删除及运行状态待保存，非业务三类。","line":2222,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"verificationChecks/history/results、指纹、stage/tasks/feedback和context已改；随后还可能改executionPlan并发另一事件，再return。","line":2312,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"executionPlan.status改为waiting-acceptance；随后return。","line":2319,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"失败结果/feedback或preparation.phase/summary在该轮修改；下一轮可能先store.save，最终轮退出后由beginResult.finally保存，非紧跟。","line":2347,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"verificationPending/stage/feedback和可选executionPlan.status修改；方法结束。","line":2365,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"p.features删除目标；下一句this.save(p)。","line":2380,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"失效验收的stage/pending/tasks/results/prototypeResult/plan/preparation已改；下一句this.save(p)，随后抛错。","line":2403,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"f.stage改done；后面可能推进执行计划、追加context，2433同一路径末尾this.save(p)，非紧跟。","line":2408,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"executionPlan.currentIndex/status修改；后面追加context，2433同一路径末尾save，非紧跟。","line":2417,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"stage/feedback/task.done修改；后面可能改plan并发事件，再2456 save，非紧跟。","line":2447,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"executionPlan.status改stopped；离开此if后下一句2456 this.save(p)，无中间业务修改/await。","line":2454,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"是"},{"note":"stdout回调本体只有事件；previews Map不属store.data。","line":2542,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"stderr回调本体只有事件。","line":2543,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"child error回调本体只有事件；previewUrl清空另在close回调且立即保存。","line":2544,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"project.activity已赋值；随后调用work，并在Promise.finally末尾保存，非紧跟。","line":2608,"file":"src/main/engineering/service.ts","businessBefore":"有","explicitSaveAfter":"否"},{"note":"TaskRevisionChanged专用catch分支未修改业务便发stopped；后续finally清activity并save。","line":2612,"file":"src/main/engineering/service.ts","businessBefore":"无","explicitSaveAfter":"否"},{"note":"有feature且阶段匹配时修改stage/pending/preparation/feedback；关联running执行计划可改stopped。无feature路径可能没有业务改动。随后throw；finally后续保存。","line":2644,"file":"src/main/engineering/service.ts","businessBefore":"条件","explicitSaveAfter":"否"},{"note":"project.activity=null后调用save；save内normalize/sync/store.save/export任一步可抛，不保证业务已保存。没有后续补save。","line":2662,"file":"src/main/engineering/service.ts","businessBefore":"未知","explicitSaveAfter":"否"}]
let w1State, measurementMetadata
fs.mkdirSync(output, { recursive: true })

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return { n: 0, min: null, median: null, p95: null, max: null }
  const middle = Math.floor(sorted.length / 2)
  return { n: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1) }
}
function parts(data) {
  const remaining = { ...data }, values = { receipts: data.receiptJournals, checkpoints: data.executionCheckpoints, originals: data.runtimeOriginals }
  delete remaining.receiptJournals; delete remaining.executionCheckpoints; delete remaining.runtimeOriginals
  for (const name of ['allowance', 'requests', 'compactions', 'receiptViews', 'events', 'runtimeState', 'changes']) values[name] = []
  remaining.projects = data.projects.map(project => {
    const p = { ...project }; values.events.push(project.events); values.changes.push(project.changes)
    delete p.events; delete p.changes
    p.features = project.features.map(feature => {
      const f = { ...feature }, state = { ...feature.contextRuntime }
      values.allowance.push(feature.runtimeBudget); delete f.runtimeBudget
      values.requests.push(state.requests); delete state.requests
      values.compactions.push([state.compactions, state.operations, state.latestBudget]); delete state.compactions; delete state.operations; delete state.latestBudget
      values.receiptViews.push(state.receipts); delete state.receipts
      values.runtimeState.push(state); delete f.contextRuntime
      return f
    })
    return p
  })
  values.business = remaining
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, hash(JSON.stringify(value ?? null))]))
}
function source(row) {
  if (row.inTime) return 'active-time'
  if (row.inReserve) return 'allowance-' + row.inReserve
  if (row.inEvent) return row.inEvent === 'output' ? 'event-output' : 'events'
  const changed = row.changed ?? []
  if (changed.includes('receipts')) return 'receipts'
  if (changed.includes('requests')) return 'requests-usage'
  if (changed.includes('checkpoints')) return 'checkpoints'
  if (changed.includes('compactions')) return 'compactions-operations-budget'
  if (changed.includes('changes')) return 'changes'
  return 'other'
}
const businessChanged = row => ['originals', 'changes', 'business'].some(part => row.changed?.includes(part))

function discoverEventSites() {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(directory, item.name)) : item.name.endsWith('.ts') ? [path.join(directory, item.name)] : [])
  for (const file of walk(path.resolve('src/main'))) {
    const content = fs.readFileSync(file, 'utf8')
    const original = ts.createSourceFile(file, content, ts.ScriptTarget.ES2022, true)
    const compiled = ts.createSourceFile(file, ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, ts.ScriptTarget.ES2022, true)
    const calls = tree => {
      const found = []
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'event' && /(?:^|\.)store$/.test(node.expression.expression.getText(tree))) found.push(node)
        ts.forEachChild(node, visit)
      }; visit(tree); return found
    }
    const a = calls(original), b = calls(compiled)
    assert.equal(a.length, b.length, 'event callsites survive transpilation')
    a.forEach((node, index) => {
      const pos = original.getLineAndCharacterOfPosition(node.getStart(original)), generated = compiled.getLineAndCharacterOfPosition(b[index].getStart(compiled))
      const kind = node.arguments[1]
      const relative = path.relative(process.cwd(), file).replace(/\\/g, '/'), audit = eventAudit.find(site => site.file === relative && site.line === pos.line + 1)
      assert.ok(audit, 'static event audit must match the measured product revision')
      eventSites.push({ ...audit, file: relative, line: pos.line + 1, generatedLine: generated.line + 3,
        kind: ts.isStringLiteral(kind) ? kind.text : kind.getText(original), literalKind: ts.isStringLiteral(kind), feature: node.arguments.length >= 4,
        expression: node.getText(original).replace(/\s+/g, ' '), reached: {}, piggyback: 0 })
    })
  }
  return eventSites
}

function measure(ctx, workload, pass) {
  const store = ctx.service.store, started = performance.now(), rows = [], reservations = []
  const original = { save: store.save, event: store.event, write: fs.writeFileSync, sync: fs.fsyncSync, rename: fs.renameSync,
    reserveTime: budget.RuntimeBudgetLease.prototype.reserveTime, reserve: budget.RuntimeBudgetLease.prototype.reserve }
  let prior = pass === 'changes' ? parts(store.data) : undefined
  let active, inEvent = '', inTime = 0, inReserve = '', eventSite, latestTool = '', wireRequest = 0
  const noteRequest = n => { wireRequest = n }
  const latest = () => Object.values(store.data.receiptJournals?.[key]?.receipts ?? {}).at(-1)?.tool || latestTool
  fs.writeFileSync = function (target, data, ...args) {
    if (!active || String(target) !== store.path + '.tmp') return original.write.call(this, target, data, ...args)
    const at = performance.now(); active.bytes = Buffer.byteLength(data); active.writeSeen = true
    if (pass === 'timing') active.byteCountMs = performance.now() - at
    if (pass === 'timing') active.serializationMs = at - active.started
    const writeStarted = performance.now()
    try { return original.write.call(this, target, data, ...args) }
    finally { if (pass === 'timing') active.writeMs += performance.now() - writeStarted }
  }
  fs.fsyncSync = function (...args) {
    if (!active?.writeSeen) return original.sync.apply(this, args)
    const at = performance.now()
    try { return original.sync.apply(this, args) } finally { if (pass === 'timing') active.fsyncMs += performance.now() - at }
  }
  fs.renameSync = function (from, to) {
    if (!active || String(to) !== store.path) return original.rename.call(this, from, to)
    const at = performance.now(); active.renameAttempts++
    try { return original.rename.call(this, from, to) } finally { if (pass === 'timing') active.renameMs += performance.now() - at }
  }
  store.save = function () {
    const next = pass === 'changes' ? parts(store.data) : undefined
    const row = { workload, pass, sequence: rows.length + 1, elapsedMs: performance.now() - started, request: wireRequest,
      requestRecord: ctx.feature.contextRuntime?.requests?.length ?? 0, tool: latest(), inEvent, inTime, inReserve,
      ...(eventSite ? { eventSite: eventSite.file + ':' + eventSite.line } : {}), bytes: 0, renameAttempts: 0,
      ...(pass === 'changes' ? { changed: Object.keys(next).filter(name => next[name] !== prior[name]) } :
        { serializationMs: 0, writeMs: 0, fsyncMs: 0, renameMs: 0 }) }
    active = { ...row, started: performance.now() }
    try {
      original.save.call(this)
      if (pass === 'timing') { active.rawTotalMs = performance.now() - active.started; active.totalMs = active.rawTotalMs - (active.byteCountMs ?? 0) }
      delete active.started; delete active.writeSeen
      active.renameRetries = Math.max(0, active.renameAttempts - 1); delete active.renameAttempts
      active.source = pass === 'changes' ? source(active) : undefined
      rows.push(active); prior = next
      if (eventSite && pass === 'changes') {
        eventSite.reached[workload] = (eventSite.reached[workload] ?? 0) + 1
        if (businessChanged(active)) eventSite.piggyback++
      }
    } finally { active = undefined }
  }
  store.event = function (project, kind, message, ...rest) {
    const previous = { inEvent, eventSite }; inEvent = kind
    if (kind === 'tool') latestTool = String(message).split(' ')[0]
    // Stack positions only identify static event sites; source attribution uses entry markers and state changes.
    const stack = new Error().stack ?? '', line = Number(stack.split('\n')[2]?.match(/<anonymous>:(\d+):\d+/)?.[1])
    const candidates = eventSites.filter(site => site.generatedLine === line && (!site.literalKind || site.kind === kind))
    eventSite = candidates.length === 1 ? candidates[0] : undefined
    if (pass === 'changes' && !eventSite) eventLocationFailures.push({ workload, kind, generatedLine: line, candidates: candidates.map(site => site.file + ':' + site.line) })
    try { return original.event.call(this, project, kind, message, ...rest) }
    finally { inEvent = previous.inEvent; eventSite = previous.eventSite }
  }
  budget.RuntimeBudgetLease.prototype.reserve = function (dimension) {
    const outer = inReserve; inReserve = dimension
    try { return original.reserve.apply(this, arguments) } finally { inReserve = outer }
  }
  budget.RuntimeBudgetLease.prototype.reserveTime = function () {
    const first = rows.length, entered = performance.now(); inTime++
    try { return original.reserveTime.apply(this, arguments) }
    finally {
      inTime--
      const saved = rows.slice(first).filter(row => row.inTime)
      reservations.push({ workload, pass, sequence: reservations.length + 1, elapsedMs: entered - started, saves: saved.length,
        saveSequences: saved.map(row => row.sequence), ...(pass === 'timing' ? { saveMs: saved.reduce((sum, row) => sum + row.totalMs, 0) } : {}), reservationWindow: this.reservationWindow })
    }
  }
  return { rows, reservations, noteRequest, restore() {
    store.save = original.save; store.event = original.event
    fs.writeFileSync = original.write; fs.fsyncSync = original.sync; fs.renameSync = original.rename
    budget.RuntimeBudgetLease.prototype.reserveTime = original.reserveTime; budget.RuntimeBudgetLease.prototype.reserve = original.reserve
  } }
}

function setup(workload) {
  const ctx = fixture(), agent = ctx.service.store.data.agents.find(a => a.id === 'developer')
  agent.tools = [...new Set([...agent.tools, 'search_files', 'read_file_lines', 'patch_file'])]
  if (workload !== 'W2') { ctx.feature.runtimePolicy = 'receipts-effects-v1'; ctx.feature.runtimeBudget = budget.newRuntimeBudget(key) }
  if (workload === 'W1' || workload === 'W2') {
    ctx.feature.contextPolicy = { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
    ctx.service.store.data.models[0].capabilities = { contextWindowTokens: 256000, maxOutputTokens: 8192, outputParameter: 'max_tokens', windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output' }
  }
  fs.writeFileSync(path.join(ctx.root, 'r'), Array.from({ length: 150 }, (_, i) => String.fromCharCode(33 + i % 90)).join(''))
  fs.writeFileSync(path.join(ctx.root, 'c.cjs'), "console.log(process.argv[2]);process.exitCode=0")
  fs.writeFileSync(path.join(ctx.root, 'slow.cjs'), "console.log('START_'+process.argv[2]);setTimeout(()=>{console.log('END_'+process.argv[2]);process.exitCode=0},5000)")
  if (workload === 'compactions') for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(ctx.root, 'material-' + i + '.txt'), 'SOURCE_' + i + '_' + '中'.repeat(5900))
  return ctx
}
function replyFor(ctx, workload, req, n) {
  if (workload === 'W1' || workload === 'W2') {
    if (n <= 15) return { text: '', calls: Array.from({ length: 10 }, (_, i) => tool('read_file', { path: 'r', offset: (n - 1) * 10 + i, limit: 1 }, ((n - 1) * 10 + i).toString(36))) }
    if (n <= 25) return { text: '', calls: Array.from({ length: 5 }, (_, i) => tool('write_file', { path: 'w', content: ((n - 16) * 5 + i).toString(36) }, 'w' + ((n - 16) * 5 + i).toString(36))) }
    if (n <= 35) return { text: '', calls: Array.from({ length: n <= 30 ? 3 : 2 }, (_, i) => tool('run_command', { program: 'node', args: ['c.cjs', n + '-' + i], timeoutSeconds: 10 }, 'c' + n + i)) }
    return done()
  }
  if (workload === 'W3') return n <= 3 ? call('run_command', { program: 'node', args: ['slow.cjs', String(n)], timeoutSeconds: 10 }) : done()
  if (workload === 'compactions') return n <= 4 ? { text: '', calls: Array.from({ length: 10 }, (_, i) => tool('read_file', { path: 'material-' + ((n - 1) * 10 + i) + '.txt' }, 'large-' + n + '-' + i)) } : done()
  const system = req.system, history = req.body.messages.filter(m => m.role === 'tool')
  if (system.includes('VERIFICATION_DIAGNOSIS')) return history.length ? answer({ summary: '已核对本机文件', gaps: ctx.feature.verificationPreparation.gaps.map(gap => ({ criterion: gap.criterion, disposition: 'automatic', reason: '缺少实际行为检查', nextStep: '添加 tests/verify.cjs 并登记测试命令。' })) }) : call('list_files', {})
  if (system.includes('VERIFICATION_PREPARATION')) {
    if (!history.some(m => m.content.includes('已写入 tests/verify.cjs'))) return call('write_file', { path: 'tests/verify.cjs', content: testScript() })
    if (!history.some(m => m.content.includes('package.json'))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8')); manifest.scripts['test:verification'] = 'node tests/verify.cjs'
      return call('write_file', { path: 'package.json', content: JSON.stringify(manifest) })
    }
    return answer({ status: 'ready', summary: '已生成真实断言脚本并补齐命令。', nextStep: '独立执行检查。' })
  }
  if (system.includes('你是 Coprojer 的开发智能体')) return answer({ status: 'complete', summary: '实现已提交', nextStep: '独立验证' })
  if (fs.existsSync(path.join(ctx.root, 'tests/verify.cjs')) && !history.length) return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKind: 'unit' })
  const passed = history.some(m => m.content.includes('ACTUAL_ASSERTION_PASSED'))
  return answer({ summary: '按真实检查报告', results: ctx.feature.criteria.map(criterion => ({ criterion, passed, status: passed ? 'passed' : 'unverified', evidence: passed ? '独立执行 tests/verify.cjs 断言通过。' : '缺少行为检查脚本。', evidenceKind: 'unit', commandIds: passed ? ['check-1'] : [] })) })
}
async function runBounded(service) {
  service.runFeature('p', 'f')
  const deadline = Date.now() + 900000
  while (service.store.project('p').activity && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (service.store.project('p').activity) {
    service.stop('p')
    const cleanup = Date.now() + 15000
    while (service.store.project('p').activity && Date.now() < cleanup) await new Promise(resolve => setTimeout(resolve, 20))
    throw new Error('Controlled workload did not settle in fifteen minutes')
  }
}
function saveRows(workload, measurement) {
  allRows.push(...measurement.rows); allReservations.push(...measurement.reservations)
  fs.writeFileSync(path.join(output, 'saves-' + workload + '.jsonl'), allRows.filter(row => row.workload === workload).map(row => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(path.join(output, 'reservations-' + workload + '.jsonl'), allReservations.filter(row => row.workload === workload).map(row => JSON.stringify(row)).join('\n') + '\n')
}
async function workload(name, pass) {
  const ctx = setup(name); let measurement
  const server = await provider((req, n) => {
    measurement?.noteRequest(n)
    return { ...replyFor(ctx, name, req, n), usage: { prompt_tokens: 1000 + n, completion_tokens: 80, total_tokens: 1080 + n } }
  })
  Object.assign(ctx.service.store.data.models[0], { baseUrl: server.url, protocol: 'chat' }); ctx.service.store.save()
  measurement = measure(ctx, name, pass)
  const started = performance.now()
  try {
    await runBounded(ctx.service)
    if (name === 'W4') { assert.equal(ctx.feature.stage, 'acceptance', JSON.stringify(ctx.project.events.slice(-8))); ctx.service.accept('p', 'f'); assert.equal(ctx.feature.stage, 'done') }
    const row = { workload: name, pass, elapsedMs: performance.now() - started, requests: server.requests.length,
      tools: ctx.project.events.filter(event => event.kind === 'tool').length, budget: ctx.feature.runtimeBudget?.used,
      stage: ctx.feature.stage, runtimeStatus: ctx.feature.contextRuntime?.status, reason: ctx.feature.contextRuntime?.reason,
      contextPolicy: ctx.feature.contextPolicy?.mode ?? 'legacy', contextWindowTokens: ctx.service.store.data.models[0].capabilities?.contextWindowTokens,
      compactions: ctx.feature.contextRuntime?.compactions?.length ?? 0, saves: measurement.rows.length,
      nonTime: measurement.rows.filter(row => !row.inTime).length, stable: measurement.rows.filter(row => !row.inTime && row.inEvent !== 'output').length,
      output: measurement.rows.filter(row => row.inEvent === 'output').length, providerErrors: server.errors,
      requestSizes: server.requests.map((request, index) => ({ request: index + 1, characters: JSON.stringify(request.body).length,
        system: request.system.length, history: JSON.stringify(request.body.messages.slice(1)).length,
        tools: JSON.stringify(request.body.messages.filter(message => message.role === 'tool')).length,
        assistant: JSON.stringify(request.body.messages.filter(message => message.role === 'assistant')).length })) }
    results.push(row)
    console.log(JSON.stringify({ ...row, requestSizes: undefined }))
    assert.deepEqual(server.errors, [])
    if (name === 'W1' || name === 'W2') {
      assert.equal(row.requests, 36, '35 tool rounds and one final reply')
      assert.equal(row.tools, 225, 'all tools execute')
      assert.equal(row.compactions, 0, 'main workload must not compact')
      if (name === 'W1') { assert.equal(row.budget.requests, 36); assert.equal(row.budget.tools, 225); w1State = clone(ctx.service.store.data) }
    }
    if (name === 'compactions') assert.ok(row.compactions > 0, 'supplemental workload must compact')
  } finally { measurement.restore(); saveRows(name, measurement); await server.close() }
}

function largeState(ctx, target) {
  const state = clone(w1State), project = state.projects.find(p => p.id === 'p'), original = project.features.find(f => f.id === 'f')
  project.root = ctx.root; project.events = []; project.agentRuns = []; project.activity = null
  const savedFeature = clone(original), journal = clone(state.receiptJournals[key]), checkpoint = clone(state.executionCheckpoints[key])
  project.features = []; state.receiptJournals = {}; state.executionCheckpoints = {}
  let count = 0, previous = 0, bytes = 0
  do {
    const id = 'f-' + ++count, feature = clone(savedFeature); feature.id = id; feature.stage = 'done'; project.features.push(feature)
    const copyJournal = clone(journal); for (const receipt of Object.values(copyJournal.receipts)) receipt.scopeId = id
    state.receiptJournals[JSON.stringify(['p', id])] = copyJournal
    const copyCheckpoint = clone(checkpoint); copyCheckpoint.featureId = id; state.executionCheckpoints[JSON.stringify(['p', id])] = copyCheckpoint
    previous = bytes; bytes = Buffer.byteLength(JSON.stringify(state, null, 2))
  } while (bytes < target)
  if (count > 1 && Math.abs(previous - target) < Math.abs(bytes - target)) {
    project.features.pop(); delete state.receiptJournals[JSON.stringify(['p', 'f-' + count])]; delete state.executionCheckpoints[JSON.stringify(['p', 'f-' + count])]; count--; bytes = previous
  }
  ctx.service.store.data = state
  return { features: count, bytes }
}
async function largeFiles(pass) {
  for (const mb of [5, 20, 50]) {
    const ctx = fixture(), sizing = largeState(ctx, mb * 1000000), name = 'W5-' + mb + 'MB'
    const measurement = measure(ctx, name, pass)
    try { for (let i = 0; i < 20; i++) ctx.service.store.save() }
    finally { measurement.restore(); saveRows(name, measurement) }
    fs.writeFileSync(path.join(ctx.profile, 'crash-fixture.json'), JSON.stringify({ kind: 'isolated-context-crash-test' }))
    if (pass === 'timing') for (let i = 0; i < 5; i++) {
      const bytes = fs.statSync(ctx.service.store.path).size
      let start = performance.now(); JSON.parse(fs.readFileSync(ctx.service.store.path, 'utf8')); const readParseMs = performance.now() - start
      start = performance.now(); restoreIsolated(ctx.profile); const restoreMs = performance.now() - start
      reopenRows.push({ workload: name, repetition: i + 1, bytes, readParseMs, restoreMs })
    }
    results.push({ workload: name, pass, ...sizing, saves: measurement.rows.length, nonTime: 20, stable: 20, output: 0 })
    console.log(JSON.stringify(results.at(-1)))
  }
}

function groupCount(rows, field) { const result = {}; for (const row of rows) { const key = row[field] || '(none)'; result[key] = (result[key] ?? 0) + 1 }; return result }
function summarize() {
  const comparisons = []
  for (const name of [...new Set(results.map(row => row.workload))]) {
    const pair = results.filter(row => row.workload === name), timing = pair.find(row => row.pass === 'timing'), changes = pair.find(row => row.pass === 'changes')
    if (!timing || !changes) continue
    comparisons.push({ workload: name, timingNonTime: timing.nonTime, changesNonTime: changes.nonTime, timingStable: timing.stable, changesStable: changes.stable,
      outputDifference: changes.output - timing.output, stableMatch: timing.stable === changes.stable })
    const a = allRows.filter(row => row.workload === name && row.pass === 'timing' && !row.inTime && row.inEvent !== 'output')
    const b = allRows.filter(row => row.workload === name && row.pass === 'changes' && !row.inTime && row.inEvent !== 'output')
    if (a.length === b.length) a.forEach((row, i) => {
      const labels = value => [value.request, value.inEvent, value.inReserve, value.tool]
      assert.deepEqual(labels(row), labels(b[i]), name + ': stable save sequence labels must match before source transfer')
      row.source = b[i].source
    })
    for (const row of allRows.filter(row => row.workload === name && row.pass === 'timing')) if (!row.source) row.source = source(row)
    fs.writeFileSync(path.join(output, 'saves-' + name + '.jsonl'), allRows.filter(row => row.workload === name).map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  const sources = {}, costs = {}, piggyback = {}, growth = {}, times = {}
  for (const name of ['W1', 'W2', 'W3', 'W4', 'compactions']) {
    const changed = allRows.filter(row => row.workload === name && row.pass === 'changes')
    const timed = allRows.filter(row => row.workload === name && row.pass === 'timing')
    sources[name] = groupCount(changed, 'source')
    times[name] = Object.fromEntries(['bytes', 'serializationMs', 'writeMs', 'fsyncMs', 'renameMs', 'totalMs'].map(field => [field, statistics(timed.map(row => row[field]))]))
    growth[name] = [...new Set(timed.map(row => row.request))].map(request => {
      const nextStart = timed.find(row => row.request === request && row.inEvent === 'model')
      const candidates = timed.filter(row => row.request === request && (!nextStart || row.sequence < nextStart.sequence))
      const row = candidates.at(-1)
      return row ? { request, bytes: row.bytes, saveSequence: row.sequence, boundary: nextStart ? 'before-next-model-event' : 'final-workload-save' } : undefined
    }).filter(Boolean)
    for (const row of changed) {
      const label = row.inEvent ? 'event:' + row.inEvent : ['receipts', 'requests-usage', 'allowance-requests', 'allowance-tools', 'active-time'].includes(row.source) ? row.source : undefined
      if (!label) continue
      const entry = piggyback[label] ??= { saves: 0, business: 0, workloads: {} }; entry.saves++; if (businessChanged(row)) entry.business++
      const per = entry.workloads[name] ??= { saves: 0, business: 0 }; per.saves++; if (businessChanged(row)) per.business++
    }
    if (name === 'W1' || name === 'W2') {
      const groups = { read: [1, 15, 150], write: [16, 25, 50], command: [26, 35, 25] }
      const eventTypes = new Set(['tool', 'tool-result'])
      const commandNoChange = changed.filter(row => name === 'W2' && row.source === 'other' && row.changed.length === 0 && row.tool === 'run_command' && row.request >= 26 && row.request <= 35)
      for (const row of commandNoChange) {
        const index = changed.indexOf(row)
        assert.equal(changed[index - 1]?.inEvent, 'output', 'unchanged command save follows output')
        assert.equal(changed[index + 1]?.inEvent, 'tool-result', 'unchanged command save precedes tool result')
      }
      const toolRows = changed.filter(row => !row.inTime && (row.source === 'receipts' || row.source === 'allowance-tools' || row.source === 'changes' || eventTypes.has(row.inEvent) || row.inEvent === 'output' || commandNoChange.includes(row)))
      const perTool = Object.fromEntries(Object.entries(groups).map(([label, [min, max, calls]]) => {
        const rows = toolRows.filter(row => row.request >= min && row.request <= max)
        return [label, { calls, saves: rows.length, savesPerCall: rows.length / calls, bySource: groupCount(rows, 'source') }]
      }))
      const requestRows = changed.filter(row => row.source === 'requests-usage' || row.source === 'compactions-operations-budget' || row.source === 'allowance-requests' || row.inEvent === 'model')
      const checkpointRows = changed.filter(row => row.source === 'checkpoints')
      const modeled = requestRows.length / 36 * 72 + Object.values(perTool).reduce((sum, item) => sum + item.saves, 0) + checkpointRows.length / 36 * 72
      costs[name] = { requestSaves: requestRows.length, requestSavesPerRequest: requestRows.length / 36, checkpointSaves: checkpointRows.length, checkpointSavesPerRequest: checkpointRows.length / 36,
        tool: perTool, commandNoChangeSaveSequences: commandNoChange.map(row => row.sequence), scaled72Requests225Tools: modeled, excludedActiveTime: changed.filter(row => row.inTime).length,
        otherFixed: changed.length - requestRows.length - checkpointRows.length - toolRows.length - changed.filter(row => row.inTime).length }
    }
  }
  const w5 = Object.fromEntries([5, 20, 50].map(mb => { const name = 'W5-' + mb + 'MB', rows = allRows.filter(row => row.workload === name && row.pass === 'timing')
    return [name, { bytes: rows[0]?.bytes, saves: rows.length, segments: Object.fromEntries(['serializationMs', 'writeMs', 'fsyncMs', 'renameMs', 'totalMs'].map(field => [field, statistics(rows.map(row => row[field]))])),
      readParseMs: statistics(reopenRows.filter(row => row.workload === name).map(row => row.readParseMs)), restoreMs: statistics(reopenRows.filter(row => row.workload === name).map(row => row.restoreMs)) }] }))
  const summary = { metadata: measurementMetadata ?? { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), productCommit: '39d7299', machine: os.hostname(), platform: process.platform, arch: process.arch, node: process.version,
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), syntheticUsage: true },
    results, comparisons, sources, costs, times, growth, reservations: allReservations.filter(row => row.workload === 'W3'), w5, reopenRows, piggyback,
    discrepancies: [
      '静态事件总数 62 与计划一致；41 处传第 4 参数（36 明确功能、5 可选功能），21 处不传。计划的 44/18 分类不符；可选参数不等于每次运行都有功能归属。',
      '默认 legacy 的初始及短输入探针均为 36 请求 / 225 工具并压缩 2 次；小于 1 KB 的文件不能保证历史低于 empty+46000 字符。为按设计将压缩成本单列，W1/W2 仅在隔离夹具显式声明 256000 token 容量并使用已有 adaptive 策略，使用受控 usage；这些主数字不是默认 legacy 策略数字。原始探针保存在 probe-original-legacy/ 与 probe-short-legacy/。',
      ...(costs.W1 ? ['W1 同比例折算 72 请求 / 225 工具为 ' + costs.W1.scaled72Requests225Tools + ' 次（不含活动时间及固定启停），相对推算 1850 差 ' + (costs.W1.scaled72Requests225Tools - 1850) + '。真实流式 usage 保存、每组检查点和不同工具种类成本已单列，不能统一按每工具 6 次计算。'] : []),
      '计划的变更登记“每次写文件一次”只覆盖无回执路径；回执路径的变更由 applied 的 ledger.put 捎带保存，本脚本按触发来源归入回执。',
      '部分保存没有摘要变化，进入标记不能归因的记录保留 other，未从调用栈猜测保存来源。' ],
    eventLocationFailures, eventSites: eventSites.map(({ generatedLine, expression, literalKind, ...site }) => site) }
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'reopens-W5.jsonl'), reopenRows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const pretty = value => JSON.stringify(value, null, 2)
  const markdown = '# 存储步骤 0 本机实测\n\n' + pretty(summary.metadata) + '\n\n' +
    '本报告是隔离合成负载。受控服务走实际 HTTP/SSE 路径，usage 是固定受控值，不是供应商计费样本。W1/W2 的夹具显式使用 adaptive 与 256000 token 容量以隔离压缩成本；其他负载为 legacy。所有保存调用均调用原方法。timing 与 changes 两遍分开；变化归类采用标记优先，再按回执、请求、检查点、压缩、变更顺序。四段之和与 totalMs 的差包含 open/close 等开销；rawTotalMs 包含计字节开销，totalMs 已减去 byteCountMs。时间单位 ms，字节为 UTF-8。\n\n' +
    '## 1. 保存来源与两遍计数\n\n```json\n' + pretty({ sources, results, comparisons }) + '\n```\n\n' +
    '## 2. 单位成本及 72 请求 / 225 工具折算\n\n请求成本包含 model 事件、请求额度、请求/用量、预算；检查点单列（读组一次准备、每组完成及请求前等保存不能错误摊成每工具一次）。工具成本包含回执、工具额度、tool/tool-result/output 事件和独立变更保存。W2 每命令还有一次 files.ts:582 finally 保存，即使无文件变化也发生；这 25 条在来源中保留 other，但按 output 与 tool-result 之间的事件边界计入命令成本，不能算成固定开销。固定启停开销和时间续约单列。\n\n```json\n' + pretty(costs) + '\n```\n\n' +
    '## 3. 单次字节、四段耗时及每回合末主文件大小\n\n```json\n' + pretty({ times, growth }) + '\n```\n\n' +
    '## 4. W3 活动时间续约\n\n```json\n' + pretty({ reservations: summary.reservations, output: sources.W3?.['event-output'] }) + '\n```\n\n' +
    '## 5. W5 合成大文件\n\n完成记录按完整功能、台账、检查点整份复制，取最接近 5/20/50 MB 的份数；20 次保存，两遍；5 次读入只在 timing 遍测。restoreMs 包含 EngineeringService 初始化和构造保存，readParseMs 只读文件及 JSON.parse；不是未来日志重放耗时。\n\n```json\n' + pretty(w5) + '\n```\n\n' +
    '## 6. 业务状态捎带\n\n业务状态按设计最后三部分 originals、changes、business 判断；contextSnapshots 没有从“业务其余”中另拆，按设计原样纳入。静态点位见 event-callsites.md。\n\n```json\n' + pretty(piggyback) + '\n```\n\n' +
    '## 7. 与计划现状的核对\n\n' + summary.discrepancies.map(item => '- ' + item).join('\n') + '\n\n没有据此改变可靠性分级、续约窗口或调用点。静态点位及人工核对说明见 event-callsites.md。\n'
  fs.writeFileSync(path.join(output, 'summary.md'), markdown)
  return summary
}

async function main() {
  discoverEventSites()
  if (process.argv.includes('--summarize')) {
    const previous = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'))
    measurementMetadata = previous.metadata; results.push(...previous.results); reopenRows.push(...previous.reopenRows); eventLocationFailures.push(...previous.eventLocationFailures)
    for (const name of [...new Set(results.map(row => row.workload))]) {
      for (const [prefix, target] of [['saves-', allRows], ['reservations-', allReservations]]) {
        const data = fs.readFileSync(path.join(output, prefix + name + '.jsonl'), 'utf8').trim()
        if (data) target.push(...data.split('\n').map(line => JSON.parse(line)))
      }
    }
    for (const site of eventSites) { const old = previous.eventSites.find(item => item.file === site.file && item.line === site.line); if (old) { site.reached = old.reached; site.piggyback = old.piggyback } }
    summarize(); console.log('PASS: recomputed summary from existing JSONL'); return
  }
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
  for (const name of ['W1', 'W2', 'W3', 'W4', 'compactions']) if (!only || only === name || only === 'W5' && name === 'W1') {
    for (const pass of ['timing', 'changes']) await workload(name, pass)
    const pair = results.filter(row => row.workload === name)
    assert.equal(pair[0].stable, pair[1].stable, name + ': stable save counts differ across passes')
  }
  if (!only || only === 'W5') for (const pass of ['timing', 'changes']) await largeFiles(pass)
  const summary = summarize()
  fs.writeFileSync(path.join(output, 'event-callsites.md'), '# store.event 静态与动态清单\n\n共 ' + eventSites.length + ' 处，41 处传功能参数（36 明确、5 可选），21 处不传。动态定位用转译后调用行号，只用于对应源码点位，不用于保存来源归类。未到达的点位只有源码判断；“未知”保留保存失败与导出失败分支的歧义。\n\n| 文件与行号 | 事件 | 传功能参数 | 之前有未保存业务修改 | 之后紧跟显式保存 | 到达负载及次数 | 捎带次数 | 静态依据 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n' + eventSites.map(site => '| ' + site.file + ':' + site.line + ' | ' + site.kind + ' | ' + (site.feature ? '是' : '否') + ' | ' + site.businessBefore + ' | ' + site.explicitSaveAfter + ' | ' + (Object.keys(site.reached).length ? JSON.stringify(site.reached) : '未到达，仅静态') + ' | ' + site.piggyback + ' | ' + site.note.replace(/\|/g, ' / ') + ' |').join('\n') + '\n')
  assert.ok(summary.comparisons.every(row => row.stableMatch))
  console.log('PASS: storage measurements written to ' + output)
}
main().catch(error => { try { summarize() } catch {} console.error(error); process.exitCode = 1 }).finally(() => {
  const resolved = path.resolve(sandbox), temporary = path.resolve(os.tmpdir()) + path.sep
  assert.ok(resolved.startsWith(temporary) && path.basename(resolved).startsWith('coprojer-preparation-'))
  fs.rmSync(resolved, { recursive: true, force: true })
})
