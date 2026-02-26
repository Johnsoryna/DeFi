# DeFi Governance Alpha Bot

A governance-event-driven trading system that monitors proposals across **Compound**, **Uniswap**, **Aave**, and **MakerDAO/Sky**, analyzes their on-chain impact, generates trading signals, and executes via **Binance USDT-M perpetuals**.

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
| 4 | Execution | Binance executor, protective order management, alerts |
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
| MakerDAO/Sky | DSChief v1.2 (deprecated) + Chief V3 (active, SKY tokens) | DSNote (lock, free, vote, lift), Etch |

Off-chain: **Snapshot** (GraphQL polling), **Discourse forums** (Aave, Compound, MakerDAO).

## Execution Venue

- **Binance Futures (USDT-M)**: leveraged perp execution with market entry + protective orders (stop-loss, trailing stop, take-profit)

## Security Notes

- **dYdX v4 client**: The `@dydxprotocol/v4-client-js` npm package was compromised on **January 27, 2026** (resolved January 30). Versions **3.4.1, 1.22.1, 1.15.2, and 1.0.31** contain wallet-stealing malware that exfiltrated seed phrases. The PyPI package `dydx-v4-client` 1.1.5post1 also included a RAT. **Safe npm version: 3.4.0.** This bot uses raw REST/WebSocket and does not depend on the npm package.
- **MEV Protection**: All on-chain transactions route through Flashbots Protect (`https://rpc.flashbots.net/fast`). Requires `maxPriorityFeePerGas > 0`.
- **Private keys**: Never commit `.env`. Wallet mnemonic and private key are loaded from environment variables only.

## Cost

Every data source used is free-tier accessible.

**DefiLlama:** As of 2026, ALL `/yields/*` endpoints (pools, charts, borrow rates, perps, LSD rates) require a **$300/month** API key. This bot does **not** call any yield endpoints — TVL and price endpoints remain free. APY is computed from on-chain reserve data instead.

**Etherscan:** Free tier reduced to **3 calls/second** (was 5). Daily limit remains 100,000 calls. Free API key at [etherscan.io](https://etherscan.io).

## License

MIT
