Review this pull request against branch `v1` as a DeFi governance trading system.

Priorities, in order:

1. correctness bugs
2. live-trading risk
3. backtest/live divergence
4. missing validation
5. operational safety

Repository-specific focus:

- `src/index.ts`
- `src/execution/*`
- `src/processing/*`
- `src/strategy/*`
- `src/backtest/*`
- `src/clients/binance.ts`

Use narrow specialist subagents when helpful, especially:

- `explorer`
- `execution_risk`
- `backtest_validator`
- `reviewer`

Constraints:

- prefer findings over summaries
- cite exact files and functions when possible
- do not ask for stylistic cleanup
- do not claim a risk is fixed unless the diff actually fixes it

Return a concise review suitable for posting on the PR.
