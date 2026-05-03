import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockedConfig = vi.hoisted(() => ({
  enableWhaleTracker: false,
}))

const mocks = vi.hoisted(() => ({
  startGovernorBravoMonitor: vi.fn(),
  stopGovernorBravoMonitor: vi.fn(),
  startAaveGovMonitor: vi.fn(),
  stopAaveGovMonitor: vi.fn(),
  startMakerGovMonitor: vi.fn(),
  stopMakerGovMonitor: vi.fn(),
  startSnapshotMonitor: vi.fn(),
  stopSnapshotMonitor: vi.fn(),
  startForumMonitor: vi.fn(),
  stopForumMonitor: vi.fn(),
  startWhaleTracker: vi.fn(),
  stopWhaleTracker: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock('../../src/config/index.js', () => ({
  config: mockedConfig,
}))

vi.mock('../../src/lib/logger.js', () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
  }),
}))

vi.mock('../../src/monitor/governorBravo.js', () => ({
  startGovernorBravoMonitor: mocks.startGovernorBravoMonitor,
  stopGovernorBravoMonitor: mocks.stopGovernorBravoMonitor,
}))

vi.mock('../../src/monitor/aaveGov.js', () => ({
  startAaveGovMonitor: mocks.startAaveGovMonitor,
  stopAaveGovMonitor: mocks.stopAaveGovMonitor,
}))

vi.mock('../../src/monitor/makerGov.js', () => ({
  startMakerGovMonitor: mocks.startMakerGovMonitor,
  stopMakerGovMonitor: mocks.stopMakerGovMonitor,
}))

vi.mock('../../src/monitor/snapshotMonitor.js', () => ({
  startSnapshotMonitor: mocks.startSnapshotMonitor,
  stopSnapshotMonitor: mocks.stopSnapshotMonitor,
}))

vi.mock('../../src/monitor/forumMonitor.js', () => ({
  startForumMonitor: mocks.startForumMonitor,
  stopForumMonitor: mocks.stopForumMonitor,
}))

vi.mock('../../src/monitor/whaleTracker.js', () => ({
  startWhaleTracker: mocks.startWhaleTracker,
  stopWhaleTracker: mocks.stopWhaleTracker,
}))

import { startAllMonitors, stopAllMonitors } from '../../src/monitor/index.js'

describe('monitor/index orchestrator', () => {
  beforeEach(() => {
    mockedConfig.enableWhaleTracker = false

    mocks.startGovernorBravoMonitor.mockReset().mockResolvedValue(undefined)
    mocks.startAaveGovMonitor.mockReset().mockResolvedValue(undefined)
    mocks.startMakerGovMonitor.mockReset().mockResolvedValue(undefined)
    mocks.startSnapshotMonitor.mockReset().mockResolvedValue(undefined)
    mocks.startForumMonitor.mockReset().mockResolvedValue(undefined)
    mocks.startWhaleTracker.mockReset().mockResolvedValue(undefined)

    mocks.stopGovernorBravoMonitor.mockReset()
    mocks.stopAaveGovMonitor.mockReset()
    mocks.stopMakerGovMonitor.mockReset()
    mocks.stopSnapshotMonitor.mockReset()
    mocks.stopForumMonitor.mockReset()
    mocks.stopWhaleTracker.mockReset()
    mocks.logInfo.mockReset()
    mocks.logWarn.mockReset()
  })

  it('starts all core monitors and whale tracker when enabled', async () => {
    mockedConfig.enableWhaleTracker = true
    await startAllMonitors()

    expect(mocks.startGovernorBravoMonitor).toHaveBeenCalledOnce()
    expect(mocks.startAaveGovMonitor).toHaveBeenCalledOnce()
    expect(mocks.startMakerGovMonitor).toHaveBeenCalledOnce()
    expect(mocks.startSnapshotMonitor).toHaveBeenCalledOnce()
    expect(mocks.startForumMonitor).toHaveBeenCalledOnce()
    expect(mocks.startWhaleTracker).toHaveBeenCalledOnce()
  })

  it('does not start whale tracker when disabled', async () => {
    mockedConfig.enableWhaleTracker = false
    await startAllMonitors()

    expect(mocks.startWhaleTracker).not.toHaveBeenCalled()
  })

  it('continues startup when optional whale tracker fails', async () => {
    mockedConfig.enableWhaleTracker = true
    mocks.startWhaleTracker.mockRejectedValueOnce(new Error('boom'))

    await expect(startAllMonitors()).resolves.toBeUndefined()
    expect(mocks.logWarn).toHaveBeenCalledOnce()
  })

  it('stops whale tracker when enabled', () => {
    mockedConfig.enableWhaleTracker = true
    stopAllMonitors()

    expect(mocks.stopGovernorBravoMonitor).toHaveBeenCalledOnce()
    expect(mocks.stopAaveGovMonitor).toHaveBeenCalledOnce()
    expect(mocks.stopMakerGovMonitor).toHaveBeenCalledOnce()
    expect(mocks.stopSnapshotMonitor).toHaveBeenCalledOnce()
    expect(mocks.stopForumMonitor).toHaveBeenCalledOnce()
    expect(mocks.stopWhaleTracker).toHaveBeenCalledOnce()
  })

  it('does not stop whale tracker when disabled', () => {
    mockedConfig.enableWhaleTracker = false
    stopAllMonitors()

    expect(mocks.stopWhaleTracker).not.toHaveBeenCalled()
  })
})
