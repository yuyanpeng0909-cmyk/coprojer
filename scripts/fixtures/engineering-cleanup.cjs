// Test-only bounds: cleanup must not hide the assertion that made this run fail.
async function bounded(label, operation, timeoutMs = 5000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs} ms`)
          error.code = 'ENGINEERING_CLEANUP_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function terminateOwnedProcess(child, timeoutMs) {
  if (!child) throw new Error('Electron did not expose its owned ChildProcess')
  let onExit, onError
  const failures = []
  try {
    // Wait for exit, not close: a descendant can keep inherited stdio open.
    if (child.exitCode === null && child.signalCode === null) {
      await bounded('owned Electron process exit', () => new Promise((resolve, reject) => {
        onExit = resolve
        onError = reject
        child.once('exit', onExit)
        child.once('error', onError)
        try {
          if (!child.kill('SIGKILL')) reject(new Error('Owned Electron process kill failed'))
        } catch (error) {
          reject(error)
        }
      }), timeoutMs)
    }
  } catch (error) {
    failures.push(error)
  } finally {
    if (onExit) child.removeListener('exit', onExit)
    if (onError) child.removeListener('error', onError)
    // Only handles returned by this app's process(); never enumerate or kill PIDs.
    for (const stream of new Set(child.stdio || [])) {
      try { stream?.destroy?.() } catch (error) { failures.push(error) }
    }
    try { child.unref() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned Electron cleanup failed')
}

async function closeOwnedElectron(app, child, { closeTimeoutMs = 10000, killTimeoutMs = 3000 } = {}) {
  try {
    await bounded('desktop.close', () => app.close(), closeTimeoutMs)
  } catch (error) {
    try {
      await terminateOwnedProcess(child, killTimeoutMs)
    } catch (cleanupError) {
      // Keep the close failure primary, including when forced cleanup also fails.
      error.cleanupError = cleanupError
    }
    throw error
  }
}

module.exports = { bounded, closeOwnedElectron }
