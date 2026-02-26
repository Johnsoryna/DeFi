/**
 * Governance Monitor orchestrator.
 * Starts and stops all governance monitoring subsystems.
 *
 * Matches backtest data sources:
 *   - On-chain: GovernorBravo (Compound), Aave Gov, Maker Gov
 *   - Snapshot: aavedao.eth, compound-governance.eth, arbitrumfoundation.eth, dydxgov.eth, 1inch.eth
 *   - Forums: aave, compound, arbitrum, dydx, cosmos, 1inch
 */
import { createLogger } from '../lib/logger.js'
import { config } from '../config/index.js'
import { startGovernorBravoMonitor, stopGovernorBravoMonitor } from './governorBravo.js'
import { startAaveGovMonitor, stopAaveGovMonitor } from './aaveGov.js'
import { startMakerGovMonitor, stopMakerGovMonitor } from './makerGov.js'
import { startSnapshotMonitor, stopSnapshotMonitor } from './snapshotMonitor.js'
import { startForumMonitor, stopForumMonitor } from './forumMonitor.js'
import { startWhaleTracker, stopWhaleTracker } from './whaleTracker.js'

const log = createLogger('monitor')

export async function startAllMonitors(): Promise<void> {
  log.info('Starting all governance monitors...')

  // On-chain monitors (Ethereum — record-only, not traded)
  await startGovernorBravoMonitor()
  await startAaveGovMonitor()
  await startMakerGovMonitor()

  // Off-chain monitors (Snapshot + Forums — primary alpha source)
  await startSnapshotMonitor()
  await startForumMonitor()

  if (config.enableWhaleTracker) {
    try {
      await startWhaleTracker()
      log.info('Whale delegation tracker enabled')
    } catch (err) {
      log.warn({ err }, 'Whale delegation tracker failed to start — continuing without whale tracking')
    }
  } else {
    log.info('Whale delegation tracker disabled')
  }

  log.info('All governance monitors started')
}

export function stopAllMonitors(): void {
  log.info('Stopping all governance monitors...')
  stopGovernorBravoMonitor()
  stopAaveGovMonitor()
  stopMakerGovMonitor()
  stopSnapshotMonitor()
  stopForumMonitor()
  if (config.enableWhaleTracker) {
    stopWhaleTracker()
  }
  log.info('All governance monitors stopped')
}
