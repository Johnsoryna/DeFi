import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const configSchema = z.object({
  // RPC
  alchemyApiKey: z.string().optional(),
  publicNodeHttp: z.string().default('https://ethereum-rpc.publicnode.com'),
  publicNodeWss: z.string().default('wss://ethereum-rpc.publicnode.com'),
  cloudflareHttp: z.string().default('https://cloudflare-eth.com'),

  // MEV Protection
  flashbotsRpc: z.string().default('https://rpc.flashbots.net/fast'),
  // MEV Blocker: ownership transferred to Special Mechanisms Group (from CoW Protocol/Agnostic Relay/Beaver Build)
  // Still free, returns 90% of backrun auction profits to users
  mevBlockerRpc: z.string().default('https://rpc.mevblocker.io'),

  // Wallet
  dydxMnemonic: z.string().optional(),
  ethPrivateKey: z.string().optional(),

  // API Keys
  etherscanApiKey: z.string().optional(),
  tallyApiKey: z.string().optional(),
  theGraphApiKey: z.string().optional(),

  // Alerting
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  discordWebhookUrl: z.string().optional(),

  // Operational
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  pollingIntervalMs: z.coerce.number().int().positive().default(12_000),
  snapshotPollIntervalMs: z.coerce.number().int().positive().default(60_000),
  forumPollIntervalMs: z.coerce.number().int().positive().default(300_000),
  dbPath: z.string().default('./data/governance.db'),
})

export type AppConfig = z.infer<typeof configSchema>

function loadConfig(): AppConfig {
  const raw = {
    alchemyApiKey: process.env.ALCHEMY_API_KEY || undefined,
    publicNodeHttp: process.env.PUBLICNODE_HTTP,
    publicNodeWss: process.env.PUBLICNODE_WSS,
    cloudflareHttp: process.env.CLOUDFLARE_HTTP,
    flashbotsRpc: process.env.FLASHBOTS_RPC,
    mevBlockerRpc: process.env.MEV_BLOCKER_RPC,
    dydxMnemonic: process.env.DYDX_MNEMONIC || undefined,
    ethPrivateKey: process.env.ETH_PRIVATE_KEY || undefined,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY || undefined,
    tallyApiKey: process.env.TALLY_API_KEY || undefined,
    theGraphApiKey: process.env.THE_GRAPH_API_KEY || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    logLevel: process.env.LOG_LEVEL,
    pollingIntervalMs: process.env.POLLING_INTERVAL_MS,
    snapshotPollIntervalMs: process.env.SNAPSHOT_POLL_INTERVAL_MS,
    forumPollIntervalMs: process.env.FORUM_POLL_INTERVAL_MS,
    dbPath: process.env.DB_PATH,
  }

  return configSchema.parse(raw)
}

export const config = loadConfig()

/** Build Alchemy HTTP URL if key is available */
export function getAlchemyHttpUrl(): string | undefined {
  if (!config.alchemyApiKey) return undefined
  return `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
}

/** Build Alchemy WSS URL if key is available */
export function getAlchemyWssUrl(): string | undefined {
  if (!config.alchemyApiKey) return undefined
  return `wss://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`
}
