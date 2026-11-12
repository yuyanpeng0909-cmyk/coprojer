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
