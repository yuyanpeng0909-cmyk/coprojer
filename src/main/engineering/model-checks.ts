import { createHash } from 'node:crypto'
import type { ModelConfig, ModelInput } from '../../shared/engineering'
import type { ModelCheckKind, ModelChecks } from '../../shared/onboarding'
import type { EngineeringStore } from './store'

// Only the main process can attest a check. Credentials never enter the receipt.
export class ModelCheckRegistry {
  private receipts = new Map<string, ModelChecks>()
  private requests = new Map<string, number>()
  constructor(private store: EngineeringStore, private resolve: (input: ModelInput) => ModelInput) {}
  private key(input: ModelInput) {
    return createHash('sha256').update(JSON.stringify([input.protocol, input.baseUrl, input.model, input.apiKey || ''])).digest('hex')
  }
  private matches(input: ModelInput, key: string) {
    try { return this.key(this.resolve(input)) === key } catch { return false }
  }
  forSave(connection: ModelInput): ModelChecks | undefined {
    const key = this.key(connection)
    const previous = this.store.data.models.find(m => m.id === connection.id)
    const saved = previous && this.matches(previous, key) ? previous.checks : undefined
    const checks = { ...saved, ...this.receipts.get(key) }
    return Object.keys(checks).length ? checks : undefined
  }
  async run(connection: ModelInput, kind: ModelCheckKind, work: () => Promise<string>): Promise<string> {
    const key = this.key(connection), requestKey = key + ':' + kind
    const request = (this.requests.get(requestKey) || 0) + 1
    this.requests.set(requestKey, request)
    let result: string
    try { result = await work() }
    catch (error) { this.record(connection, kind, 'failed', key, requestKey, request); throw error }
    this.record(connection, kind, 'passed', key, requestKey, request)
    return result
  }
  private record(connection: ModelInput, kind: ModelCheckKind, status: 'passed' | 'failed', key: string, requestKey: string, request: number) {
    if (this.requests.get(requestKey) !== request) return
    const result = { status, at: new Date().toISOString() }
    const checks = { ...this.receipts.get(key), [kind]: result }
    if (kind === 'connection' && status === 'failed') checks.capabilities = undefined
    if (kind === 'capabilities' && status === 'passed') checks.connection = result
    this.receipts.set(key, checks)
    if (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!)
    const saved = this.store.data.models.find(m => m.id === connection.id)
    // A response from an old URL, model or key cannot validate an edited connection.
    if (!saved || !this.matches(saved, key)) return
    const previous: ModelConfig['checks'] = saved.checks
    saved.checks = { ...previous, ...checks }
    try { this.store.save() } catch (error) { saved.checks = previous; this.receipts.delete(key); throw error }
  }
}
