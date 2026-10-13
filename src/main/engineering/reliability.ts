/** A durable record is part of execution, not optional telemetry. */
export class ReliabilityFailure extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ReliabilityFailure' }
}
export class RecoveryRequired extends ReliabilityFailure {
  constructor(message: string) { super(message); this.name = 'RecoveryRequired' }
}
export class EffectUncertain extends Error {}
