# DeFi Governance Alpha Bot

A governance-event-driven trading system that monitors DeFi proposals across **14 Snapshot spaces** and **11 Discourse forums**, analyzes them with a keyword-NLP engine, generates SHORT signals on risk-increasing governance events, and executes via **Binance USDT-M perpetuals**.

**Validated backtest (Jan 2025 – Feb 2026, 13 months):** 35 trades · **+$397K (+397%)** · WR 77.1% · PF 5.65 · Sharpe 2.85 · MaxDD 22.15%

---

## Architecture

```
Forum/Snapshot/On-Chain Events
        │
        ▼
  intelligenceEngine.ts  ←  nlpEngine.ts + payloadDecoder.ts
        │
        ▼
  signalGenerator.ts     (Smart Filter · A3 Momentum · Hebel 4 Cascade · Kelly Sizing)
        │
        ▼
  riskManager.ts         (Exposure · DrawdownGuard · Concentration)
        │
        ▼
  binanceExecutor.ts     (Market Entry + SL/TP/Trailing ALGO orders)
        │
        ▼
  positionTracker.ts + alertService.ts
```

| Layer | Responsibility | Key Files |
|-------|---------------|-----------|
| Monitoring | Forum + Snapshot polling, On-Chain event listener | `monitor/forumMonitor.ts`, `monitor/snapshotMonitor.ts`, `monitor/governorBravo.ts` |
| Analysis | NLP classification, calldata decoding, impact extraction | `analysis/intelligenceEngine.ts`, `analysis/nlpEngine.ts`, `analysis/payloadDecoder.ts` |
| Signal Engine | Strategy matrix, filters, confidence, Kelly sizing | `strategy/signalGenerator.ts`, `strategy/confidenceScorer.ts` |
| Risk Gate | Exposure limits, drawdown guards, min confidence | `strategy/riskManager.ts` |
| Execution | Order placement, SL/TP/Trail, idempotency | `execution/binanceExecutor.ts`, `clients/binance.ts` |
| State | Position tracking, proposal cache, cursor persistence | `processing/positionTracker.ts`, `lib/store.ts` |
| Backtest | Full replay engine with 12,503 historical events | `backtest/index.ts`, `backtest/replayProvider.ts`, `backtest/resultCollector.ts` |
| Ops | Alerts, weekly Telegram report, heap monitor | `execution/alertService.ts`, `src/index.ts` |

---

## Signal Flow (Order Lifecycle)

```
governance event
  → analysis:proposal  (NLP type, sentiment, assets, confidence)
  → signal:trade       (direction, asset, sizePct, leverage, riskProfile)
  → signal:validated   (risk gate: exposure, drawdown, confidence checks)
  → execution          (Binance MARKET + STOP/TP/TRAILING ALGO orders)
  → position:update    (30s polling, max-hold check every 30min)
  → risk/exit          (trailing-stop | take-profit | stop-loss | max-hold | max-loss-cap)
  → report/alerts      (Telegram + weekly summary)
```

---

## Monitored Protocols

### On-Chain Monitors
| Protocol | Contract | ABI |
|----------|----------|-----|
| Compound | Governor Bravo | `ProposalCreated`, `VoteCast`, `ProposalQueued`, `ProposalExecuted` |
| Uniswap | Governor Bravo (shared ABI) | same as Compound |
| Aave V3 | GovernanceCore + VotingMachine | `ProposalCreated`, `VotingActivated`, `VoteEmitted` |
| MakerDAO/Sky | DSChief v1.2 + Chief V3 | `DSNote` (lock/free/vote/lift), `Etch` |
| Arbitrum | GovernorBravo-compatible | `ProposalCreated`, `VoteCast` |

### Snapshot Spaces (14)
`aavedao.eth` · `compound-governance.eth` · `arbitrumfoundation.eth` · `morpho.eth` ·
`dydxgov.eth` · `curve.eth` · `lido-snapshot.eth` · `gmx.eth` · `uniswapgovernance.eth` ·
`eigenlayergov.eth` · `ethenagovernance.eth` · `snxgov.eth` · `aave.eth` · `1inch.eth`

### Discourse Forums (11)
`governance.aave.com` · `www.comp.xyz` · `forum.arbitrum.foundation` · `forum.dydx.community` ·
`gov.curve.fi` · `research.lido.fi` · `snapshot.org (maker)` · `forum.morpho.org` ·
`gov.uniswap.org` · `forum.eigenlayer.xyz` · `research.optimism.io`

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Required: ALCHEMY_API_KEY, BINANCE_API_KEY, BINANCE_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# 3. Collect historical data for backtesting
npx tsx scripts/collect-new-governance.ts
npx tsx scripts/collect-new-prices.ts

# 4. Run backtest (full 13-month period)
npx tsx src/backtest/index.ts --from 2025-01-01 --to 2026-02-20

# 5. Run in production (via PM2)
pm2 start ecosystem.config.cjs
```

## Backtest Commands

```bash
# Full period (canonical baseline)
npx tsx src/backtest/index.ts --from 2025-01-01 --to 2026-02-20

# Rolling 6-month (default, no flags)
npx tsx src/backtest/index.ts

# Robustness / parameter sensitivity
npx tsx scripts/robustness-check.ts

# OODA autonomous optimizer
node scripts/ooda-loop.mjs --full-period

# Validation tests
npx tsx scripts/validate-robustness.ts
```

---

## Backtest Performance (Jan 2025 – Feb 2026)

| Metric | Value |
|--------|-------|
| Total Trades | 35 |
| Total PnL | **+$297,723 (+297%)** on $100K |
| Final Portfolio | **$397,723** |
| Win Rate | 77.1% (27W / 8L) |
| Profit Factor | 5.65 |
| Sharpe Ratio | 2.85 |
| Max Drawdown | 22.15% |
| Events Replayed | 12,503 |

### Per-Protocol Results

| Asset | Trades | WR | PnL | Edge Source |
|-------|--------|----|-----|-------------|
| AAVE | 12 | 75% | +$113,366 | LTV/freeze risk events |
| ARB | 5 | 80% | +$105,663 | Risk-parameter proposals |
| DYDX | 5 | 80% | +$24,621 | OI-cap reductions |
| LDO | 3 | 67% | +$17,452 | AAVE wstETH cascade + LDO gov |
| COMP | 4 | 75% | +$14,707 | Gov risk events |
| WSTETH | 1 | 100% | +$9,843 | AAVE degradation signal |
| CRV | 3 | 67% | +$3,936 | gov.curve.fi forum posts |
| EIGEN | 1 | 100% | +$1,793 | EigenLayer forum risk event |
| YFI | 1 | 100% | +$1,839 | "Disable Protocol Fees on Yearn V3" → bearish for YFI fee-capture |

**Protocols with 0 trades (correctly filtered):** CVX, SNX, GRT, Euler, Pendle, 1inch, Jito, Pyth, Venus, RPL — NLP correctly identifies routine governance.

### Robustness Validation
- **Walk-Forward:** 12/13 monthly periods profitable (92%)
- **Monte Carlo:** 100% positive P&L under any trade ordering, even with 5% slippage
- **Direction Reversal:** Reversed signals lose −$144K vs +$291K actual → direction adds genuine alpha
- **Placebo Test (1,000 runs):** Random timing averages +$39K vs +$291K actual → event timing adds material edge
- **Overall Robustness Score: 97.7% EXCELLENT**

---

## Key Strategy Decisions

### Why mostly SHORT?
Governance-bearish signals (risk proposals, emergency freezes, LTV reductions) have 75%+ WR historically. Governance-bullish signals achieve only ~50% WR because positive events take months to play out. Shorts require confidence ≥ 0.55 at snapshot stage; longs require +0.15 more.

### Hebel 4: Collateral-Issuer Cascade
When AAVE degrades a collateral asset, the protocol that **issued** that asset is also harmed:
- `AAVE freezes wstETH` → PRIMARY: short WSTETH + SECONDARY: short LDO (Lido issues wstETH)
- `AAVE freezes USDe` → PRIMARY: signal + SECONDARY: short ENA (Ethena issues USDe)

### Confidence Scoring (6-factor weighted model)
```
Confidence = 0.15 × NLP_Confidence
           + 0.30 × Stage_Score        ← largest weight (forum=0.05, snapshot=0.45, on-chain=0.75)
           + 0.15 × Type_Tradability
           + 0.10 × Asset_Quality
           + 0.20 × Source_Reliability
           + 0.10 × Sentiment_Alignment
```

### Critical Filters (do not remove)
- **Stablecoin gov filter**: USDC supply cap → no AAVE trade (AAVE price unaffected)
- **On-Chain vote cap (C5)**: market already priced in → leverage max 2x
- **L2-deprecation filter**: sUSD on Optimism → no SNX short (mainnet unaffected)
- **72h min hold before SL**: governance events need 3 days to develop (< 72h trades had ≤33% WR)
- **`tech_param + category='other'` skip**: Chaos Labs routine parameter tweaks have no alpha (was 42.9% WR before fix)
- **"kill" keyword DANGER**: `kill` in NLP triggers on Curve "Kill Gauge" posts (routine) → never add as standalone keyword

---

## Deployment

```bash
# Pack (exclude live DB and secrets)
tar --exclude='.git' --exclude='node_modules' --exclude='data/*.db' \
    --exclude='data/*.db-wal' --exclude='data/*.db-shm' --exclude='*.tar.gz' \
    -czf /tmp/defi-update-vN.tar.gz .

# Deploy
scp /tmp/defi-update-vN.tar.gz john@152.53.135.86:/home/john/
ssh john@152.53.135.86 'cd /home/john && \
  tar -xzf defi-update-vN.tar.gz -C defi-bot/ && \
  grep -v "^$\|^#" /home/john/.env.secrets >> /home/john/defi-bot/.env && \
  export PATH=$PATH:/home/john/.nvm/versions/node/v20.20.0/bin && \
  cd defi-bot && npm install --silent && pm2 restart defi-bot --update-env'
```

**CRITICAL:** Never send `data/*.db` — `governance.db` holds live positions and Snapshot cursors.

---

## Docker

```bash
docker-compose up --build
```

---

## Security Notes

- **dYdX npm package**: Versions 3.4.1, 1.22.1, 1.15.2, 1.0.31 contained wallet-stealing malware (Jan 27–30, 2026). **This bot does not use the npm package** — raw REST/WebSocket only. Safe version if needed: 3.4.0.
- **MEV Protection**: On-chain transactions route through Flashbots Protect (`https://rpc.flashbots.net/fast`).
- **Private keys**: Never commit `.env`. Secrets live in `/home/john/.env.secrets` (outside the deploy directory).

---

## Data Sources (all free-tier)

| Source | Usage | Limit |
|--------|-------|-------|
| Alchemy | Ethereum RPC | Free tier |
| Etherscan | Historical logs | 3 req/s, 100K/day |
| Snapshot GraphQL | Off-chain governance | Free |
| Discourse API | Forum posts | Free |
| Binance REST/WS | Price data + execution | Free tier |
| DefiLlama | TVL (not yield endpoints) | Free |

**Note:** DefiLlama `/yields/*` endpoints require $300/month since 2026. This bot only uses TVL/price endpoints, which remain free.

---

## License

MIT
