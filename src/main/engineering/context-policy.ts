import type { ContextPolicy } from '../../shared/model-profile'
import type { Connection } from './model'
import { validateContextPolicy } from './context-budget'
export function contextConnection(connection: Connection, project?: ContextPolicy, run?: ContextPolicy): Connection {
  const policy = validateContextPolicy(run ?? project)
  return policy ? { ...connection, capabilities: { ...connection.capabilities, contextPolicy: policy } } : connection
}
