# DeFi Governance Alpha Bot

A governance-event-driven trading system that monitors proposals across **Compound**, **Uniswap**, **Aave**, and **MakerDAO/Sky**, analyzes their on-chain impact, generates trading signals, and executes via **dYdX v4 perps**, **Pendle yield trades**, and **DEX swaps** — all protected from MEV.

Built exclusively on **free-tier data sources**.

## Architecture

```
Monitoring → Analysis → Signal Generation → Risk Management → Execution → Alerts
```

**5-layer architecture:**

| Layer | Purpose | Key Modules |
|-------|---------|-------------|
| 0 | Foundation | Types, config, logger, SQLite, event bus |
| 1 | Data Sources | RPC client, governance monitors, API clients |
| 2 | Processing | Proposal decoder/classifier, dependency graph, position tracker, price monitor |
| 3 | Decision | Signal generator (rule engine), risk manager (stop-loss state machine) |
| 4 | Execution | dYdX executor, Pendle executor, DEX executor, flash loans, alerts |
| 5 | Orchestration | Main event loop, health checks, graceful shutdown |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys (Alchemy, Etherscan, Telegram, etc.)

# 3. Run in development mode
npm run dev

# 4. Or build and run in production
npm run build
npm start
```

## Docker

```bash
docker-compose up --build
```

## Monitored Protocols

| Protocol | Contract | Events |
|----------|----------|--------|
| Compound | Governor Bravo | ProposalCreated, VoteCast, ProposalQueued, ProposalExecuted |
| Uniswap | Governor Bravo | (same as Compound — shared ABI) |
| Aave V3 | GovernanceCore + VotingMachine | ProposalCreated, VotingActivated, VoteEmitted |
| MakerDAO/Sky | DSChief v1.2 + New Chief | DSNote (lock, free, vote, lift), Etch |

Off-chain: **Snapshot** (GraphQL polling), **Discourse forums** (Aave, Compound, MakerDAO).

## Execution Venues

- **dYdX v4**: Perpetual futures (AAVE-USD, UNI-USD, COMP-USD, MKR-USD)
- **Pendle**: Yield token trading (PT/YT swaps via API)
- **CowSwap**: MEV-protected spot swaps (free, no API key)
- **Balancer V2**: Zero-fee flash loans for atomic arbitrage

## Security Notes

- **dYdX v4 client**: The `@dydxprotocol/v4-client-js` npm package was compromised in January 2026. Versions 3.4.1, 1.22.1, 1.15.2, and 1.0.31 contain wallet stealers. Only use verified clean versions.
- **MEV Protection**: All on-chain transactions route through Flashbots Protect (`https://rpc.flashbots.net/fast`). Requires `maxPriorityFeePerGas > 0`.
- **Private keys**: Never commit `.env`. Wallet mnemonic and private key are loaded from environment variables only.

## Cost

Every data source used is free-tier accessible. **DefiLlama yield endpoints are NOT free** ($300/mo) — APY is computed from on-chain reserve data instead.

## License

MIT
