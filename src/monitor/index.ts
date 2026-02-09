/**
 * Governance Monitor orchestrator.
 * Starts and stops all governance monitoring subsystems.
 */
import { createLogger } from '../lib/logger.js'
import { startGovernorBravoMonitor, stopGovernorBravoMonitor } from './governorBravo.js'
import { startAaveGovMonitor, stopAaveGovMonitor } from './aaveGov.js'
import { startMakerGovMonitor, stopMakerGovMonitor } from './makerGov.js'
import { startSnapshotMonitor, stopSnapshotMonitor } from './snapshotMonitor.js'
import { startForumMonitor, stopForumMonitor } from './forumMonitor.js'
import { startWhaleTracker, stopWhaleTracker } from './whaleTracker.js'

const log = createLogger('monitor')

export async function startAllMonitors(): Promise<void> {
  log.info('Starting all governance monitors...')

  // On-chain monitors
  await startGovernorBravoMonitor()
  await startAaveGovMonitor()
  await startMakerGovMonitor()

  // Off-chain monitors
  await startSnapshotMonitor()
  await startForumMonitor()

  // Whale tracking
  await startWhaleTracker()

  log.info('All governance monitors started')
}

export function stopAllMonitors(): void {
  log.info('Stopping all governance monitors...')
  stopGovernorBravoMonitor()
  stopAaveGovMonitor()
  stopMakerGovMonitor()
  stopSnapshotMonitor()
  stopForumMonitor()
  stopWhaleTracker()
  log.info('All governance monitors stopped')
}
