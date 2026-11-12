const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')

function taskState(service, projectId, featureId) {
  const project = service.store.project(projectId)
  const feature = project.features.find(item => item.id === featureId)
  const checkpoint = service.store.data.executionCheckpoints?.[JSON.stringify([projectId, featureId])]
  return {
    profile: service.store.path, root: project.root,
    activity: project.activity, stage: feature?.stage, jobPresent: service.jobs.has(projectId),
    checkpoint: checkpoint && { role: checkpoint.role, steps: checkpoint.steps,
      commands: checkpoint.commands?.map(command => ({ id: command.id, code: command.code })) },
    requests: feature?.contextRuntime?.requests?.slice(-2).map(request => ({ id: request.id, status: request.status })),
    lastEvents: project.events.slice(-3).map(event => ({ kind: event.kind, message: service.store.redact(event.message).slice(0, 240) })),
  }
}

// These fixtures verify step budgets and evidence, not a 15/18-second latency SLA.
// Use the same 90-second watchdog as verification-runtime, and join the actual
// job (including its final save) before changing model stubs or deleting files.
async function runService(service, { projectId = 'p', featureId = 'f', reviewOnly = false, timeoutMs = 90000, cleanupTimeoutMs = 45000, watchdogSignal } = {}) {
  const started = performance.now(), begin = service.beginResult
  let task, watchdog, cleanupTimer, expire
  const join = () => Promise.race([task.then(() => true), new Promise(resolve => {
    // Native guard compilation can take 30s; process-tree shutdown has its own
    // 12s bound. Never start the next case while either can still be running.
    cleanupTimer = setTimeout(() => resolve(false), cleanupTimeoutMs)
  })])
  service.beginResult = function (...args) {
    const promise = begin.apply(this, args)
    if (args[0].id === projectId) {
      assert.equal(task, undefined, 'one fixture run must own one project job')
      // A product pause/rejection is inspected by the caller's business assertions.
      task = promise.then(() => undefined, () => undefined)
    }
    return promise
  }
  try {
    const expired = new Promise(resolve => {
      expire = () => resolve(false)
      watchdog = setTimeout(expire, timeoutMs)
      // Allows the lifecycle regression to expire only after its model is in
      // flight. The real watchdog still bounds that controlled experiment.
      if (watchdogSignal?.aborted) expire()
      else watchdogSignal?.addEventListener('abort', expire, { once: true })
    })
    try { service.runFeature(projectId, featureId, reviewOnly) } finally { service.beginResult = begin }
    assert.ok(task, 'runFeature must start an observable service job')
    if (await Promise.race([task.then(() => true), expired]) && performance.now() - started <= timeoutMs && !watchdogSignal?.aborted) {
      assert.equal(service.store.project(projectId).activity, null)
      assert.equal(service.jobs.has(projectId), false)
      return
    }
    const beforeStop = taskState(service, projectId, featureId)
    if (service.jobs.has(projectId)) service.stop(projectId)
    const cleaned = await join()
    const error = new Error('service watchdog expired: ' + JSON.stringify({
      timeoutMs, controlled: !!watchdogSignal?.aborted, elapsedMs: Math.round(performance.now() - started), beforeStop, afterStop: taskState(service, projectId, featureId),
    }))
    error.code = 'SERVICE_TASK_TIMEOUT'
    error.serviceCleanupFailed = !cleaned || service.jobs.has(projectId) || service.store.project(projectId).activity !== null
    throw error
  } catch (error) {
    // A synchronous start/save failure can occur before a job promise is
    // returned. It must not allow the next case to inherit an owned job.
    if (error.serviceCleanupFailed === undefined && service.jobs.has(projectId)) {
      service.stop(projectId)
      const cleaned = task ? await join() : false
      error.serviceCleanupFailed = !cleaned || service.jobs.has(projectId) || service.store.project(projectId).activity !== null
    }
    throw error
  } finally {
    service.beginResult = begin
    clearTimeout(watchdog); clearTimeout(cleanupTimer)
    watchdogSignal?.removeEventListener('abort', expire)
  }
}

module.exports = { runService, taskState }
