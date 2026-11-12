export interface ToolHook<Run, Invocation, Result> {
  name: string
  beforeIntent?(run: Run, invocation: Invocation): void
  beforeExecute?(run: Run, invocation: Invocation): void
  afterExecute?(run: Run, invocation: Invocation, output: string): string | void
  afterSettle?(run: Run, invocation: Invocation, result: Result): Result | void
}

export function runBeforeIntentHooks<Run, Invocation, Result>(hooks: readonly ToolHook<Run, Invocation, Result>[], run: Run, invocation: Invocation): void {
  for (const hook of hooks) hook.beforeIntent?.(run, invocation)
}

export function runBeforeExecuteHooks<Run, Invocation, Result>(hooks: readonly ToolHook<Run, Invocation, Result>[], run: Run, invocation: Invocation): void {
  for (const hook of hooks) hook.beforeExecute?.(run, invocation)
}

export function runAfterExecuteHooks<Run, Invocation, Result>(hooks: readonly ToolHook<Run, Invocation, Result>[], run: Run, invocation: Invocation, output: string): string {
  for (const hook of hooks) {
    const next = hook.afterExecute?.(run, invocation, output)
    if (next !== undefined) output = next
  }
  return output
}

export function runAfterSettleHooks<Run, Invocation, Result>(hooks: readonly ToolHook<Run, Invocation, Result>[], run: Run, invocation: Invocation, result: Result): Result {
  for (const hook of hooks) {
    const next = hook.afterSettle?.(run, invocation, result)
    if (next !== undefined) result = next
  }
  return result
}

export interface LegacyToolStages<Result> {
  authorize(): void
  reserve(): void
  perform(): Promise<Result>
}

export function runLegacyToolPipeline<Result>(stages: LegacyToolStages<Result>): Promise<Result> {
  stages.authorize()
  stages.reserve()
  return stages.perform()
}

export interface ReceiptToolStages<Identity, Intent, Result, Settled> {
  assertPolicySupport(): Identity
  prepareEffect(identity: Identity): void
  buildIntent(identity: Identity): Intent
  executeIntent(intent: Intent): Promise<Result>
  settle(result: Result, identity: Identity): Settled
}

export async function runReceiptToolPipeline<Identity, Intent, Result, Settled>(stages: ReceiptToolStages<Identity, Intent, Result, Settled>): Promise<Settled> {
  const identity = stages.assertPolicySupport()
  stages.prepareEffect(identity)
  const intent = stages.buildIntent(identity)
  const result = await stages.executeIntent(intent)
  return stages.settle(result, identity)
}
