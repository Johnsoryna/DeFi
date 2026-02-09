/**
 * Typed event bus for inter-module communication.
 * All governance events, trade signals, and alerts flow through here.
 */
import { EventEmitter } from 'eventemitter3'
import type { GovernanceEvent, ProposalAnalysis, CascadeImpact } from '../types/governance.js'
import type { TradeSignal, ExecutionResult, Position } from '../types/trading.js'
import type { Alert } from '../types/alerts.js'

// ─── Event Map (event name → payload type) ──────────────────────────

export interface EventMap {
  // Governance events
  'governance:proposal': GovernanceEvent
  'governance:vote': GovernanceEvent
  'governance:queued': GovernanceEvent
  'governance:executed': GovernanceEvent
  'governance:canceled': GovernanceEvent
  'governance:snapshot': GovernanceEvent
  'governance:forum': GovernanceEvent

  // Whale tracking
  'whale:delegation': GovernanceEvent

  // Analysis results
  'analysis:proposal': ProposalAnalysis
  'analysis:cascade': CascadeImpact[]

  // Trading signals
  'signal:trade': TradeSignal
  'signal:validated': TradeSignal

  // Execution results
  'execution:result': ExecutionResult

  // Position updates
  'position:update': { positions: Position[] }

  // Price updates
  'price:update': { asset: string; price: string; source: string }

  // Alerts
  'alert:send': Alert

  // System
  'system:health': { module: string; status: 'ok' | 'degraded' | 'down'; message?: string }
  'system:shutdown': { reason: string }
}

// ─── Typed Event Bus ────────────────────────────────────────────────

class TypedEventBus extends EventEmitter<EventMap> {}

/** Global event bus instance */
export const eventBus = new TypedEventBus()
