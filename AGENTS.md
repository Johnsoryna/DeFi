# AGENTS.md

This repository is a TypeScript DeFi governance trading bot. Treat it as a production trading backend, not a general web app.

## Review Guidelines

- Prioritize correctness bugs, live-trading risk, backtest/live divergence, missing validation, and operational safety.
- Focus especially on `src/index.ts`, `src/execution/*`, `src/processing/*`, `src/strategy/*`, `src/backtest/*`, and `src/clients/binance.ts`.
- Treat state divergence, duplicated trades, orphaned protection orders, incorrect PnL accounting, and restart-safety regressions as highest-priority findings.
- Ignore low-value style cleanup unless it directly affects correctness or maintainability of safety-critical code.
- Prefer specific findings with concrete file and function references over general advice.

## Change Guidelines

- Prefer the smallest defensible change.
- Preserve intended live/backtest parity unless the task explicitly changes behavior in both.
- Do not edit unrelated files.
- Add or adjust tests only when they directly validate the changed behavior.

## Repo Priorities

1. Build must stay green.
2. Live execution safety beats backtest cosmetics.
3. Backtest claims should be supported by code and validation artifacts.
4. Runtime safety and restart correctness matter more than feature breadth.
