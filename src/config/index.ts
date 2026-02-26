import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const configSchema = z.object({
  // RPC
  alchemyApiKey: z.string().optional(),
  alchemyRpcUrl: z.string().url().optional(),
  alchemyWssUrl: z.string().startsWith('wss://').optional(),
  publicNodeHttp: z.string().url().default('https://ethereum-rpc.publicnode.com'),
  publicNodeWss: z.string().startsWith('wss://').default('wss://ethereum-rpc.publicnode.com'),
  cloudflareHttp: z.string().url().default('https://cloudflare-eth.com'),

  // MEV Protection
  flashbotsRpc: z.string().url().default('https://rpc.flashbots.net/fast'),
  // MEV Blocker: ownership transferred to Special Mechanisms Group (from CoW Protocol/Agnostic Relay/Beaver Build)
  // Still free, returns 90% of backrun auction profits to users
  mevBlockerRpc: z.string().url().default('https://rpc.mevblocker.io'),

  // Exchange: Binance Futures
  binanceApiKey: z.string().optional(),
  binanceApiSecret: z.string().optional(),
  binanceTestnet: z.preprocess(
    (v) => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().default(false),
  ),
  ethPrivateKey: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),

  // API Keys
  etherscanApiKey: z.string().min(20).optional(),
  theGraphApiKey: z.string().optional(),

  // Alerting
  telegramBotToken: z.string().min(10).optional(),
  telegramChatId: z.string().optional(),
  discordWebhookUrl: z.string().url().optional(),

  // Operational
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // Default 60s keeps us within free RPC limits. With 28 event watchers:
  //   28 watchers × 1 call/min × ~75 CU = 2,100 CU/min ≈ 90M CU/month
  //   Alchemy free tier is only 30M CU/month — but Alchemy is last-resort
  //   fallback; PublicNode/Cloudflare handle >95% of traffic (unlimited, free).
  // Decrease to 12000 for faster monitoring if on a paid RPC plan.
  pollingIntervalMs: z.coerce.number().int().positive().default(60_000),
  snapshotPollIntervalMs: z.coerce.number().int().positive().default(60_000),
  forumPollIntervalMs: z.coerce.number().int().positive().default(300_000),
  onchainTradeEnabledProtocols: z.preprocess(
    (v) => {
      if (typeof v !== 'string' || v.trim() === '') return []
      return v
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
    },
    z.array(z.string()).default([]),
  ),
  enableWhaleTracker: z.preprocess(
    (v) => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().default(false),
  ),
  enableDependencyGraph: z.preprocess(
    (v) => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().default(false),
  ),
  dbPath: z.string().default('./data/governance.db'),

  // ─── Safety: DRY_RUN mode ─────────────────────────────────────
  // When true (default), orders are NOT sent to exchanges.
  // Set to "false" explicitly to enable LIVE TRADING.
  dryRun: z.preprocess(
    (v) => v === 'false' ? false : v === 'true' ? true : v,
    z.boolean().default(true),
  ),

  // Initial portfolio value in USD (used when no positions exist yet)
  initialPortfolioUsd: z.coerce.number().positive().default(10_000),
})

export type AppConfig = z.infer<typeof configSchema>

function loadConfig(): AppConfig {
  const raw = {
    alchemyApiKey: process.env.ALCHEMY_API_KEY || undefined,
    alchemyRpcUrl: process.env.ALCHEMY_RPC_URL || undefined,
    alchemyWssUrl: process.env.ALCHEMY_WSS_URL || undefined,
    publicNodeHttp: process.env.PUBLICNODE_HTTP,
    publicNodeWss: process.env.PUBLICNODE_WSS,
    cloudflareHttp: process.env.CLOUDFLARE_HTTP,
    flashbotsRpc: process.env.FLASHBOTS_RPC,
    mevBlockerRpc: process.env.MEV_BLOCKER_RPC,
    binanceApiKey: process.env.BINANCE_API_KEY || undefined,
    binanceApiSecret: process.env.BINANCE_API_SECRET || undefined,
    binanceTestnet: process.env.BINANCE_TESTNET ?? 'false',
    ethPrivateKey: process.env.ETH_PRIVATE_KEY || undefined,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY || undefined,
    theGraphApiKey: process.env.THE_GRAPH_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    logLevel: process.env.LOG_LEVEL,
    pollingIntervalMs: process.env.POLLING_INTERVAL_MS,
    snapshotPollIntervalMs: process.env.SNAPSHOT_POLL_INTERVAL_MS,
    forumPollIntervalMs: process.env.FORUM_POLL_INTERVAL_MS,
    onchainTradeEnabledProtocols: process.env.ONCHAIN_TRADE_ENABLED_PROTOCOLS ?? '',
    enableWhaleTracker: process.env.ENABLE_WHALE_TRACKER ?? 'false',
    enableDependencyGraph: process.env.ENABLE_DEPENDENCY_GRAPH ?? 'false',
    dbPath: process.env.DB_PATH,
    dryRun: process.env.DRY_RUN ?? 'true',
    initialPortfolioUsd: process.env.INITIAL_PORTFOLIO_USD,
  }

  return configSchema.parse(raw)
}

export const config = loadConfig()

/**
 * Validate critical config for live trading mode.
 * Call at startup — throws if live trading is enabled but required secrets are missing.
 */
export function validateConfigForLiveTrading(): string[] {
  const warnings: string[] = []

  if (!config.dryRun) {
    // LIVE MODE — require Binance API credentials
    if (!config.binanceApiKey || !config.binanceApiSecret) {
      throw new Error('FATAL: DRY_RUN=false but BINANCE_API_KEY/BINANCE_API_SECRET not set. Cannot place real orders.')
    }
  }

  // Alerting warnings (for both modes)
  if (!config.telegramBotToken || !config.telegramChatId) {
    warnings.push('Telegram not configured — critical alerts will only be logged')
  }

  return warnings
}

/** Build Alchemy HTTP URL if key is available */
export function getAlchemyHttpUrl(): string | undefined {
  if (config.alchemyRpcUrl) return config.alchemyRpcUrl
  if (!config.alchemyApiKey) return undefined
  return `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
}

/** Build Alchemy WSS URL if key is available */
export function getAlchemyWssUrl(): string | undefined {
  if (config.alchemyWssUrl) return config.alchemyWssUrl
  if (!config.alchemyApiKey) return undefined
  return `wss://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
}
