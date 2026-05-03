Audit branch `v1` of this repository for the highest-value remaining engineering work.

This is a DeFi governance trading bot. Prioritize:

1. build blockers
2. test gaps around live-trading safety
3. order lifecycle and state divergence risks
4. backtest/live parity issues
5. high-leverage strategy logic defects
6. operational safety and deployment hygiene

Use specialist subagents where useful:

- `explorer`
- `execution_risk`
- `backtest_validator`
- `ops_sre`
- `reviewer`

Rules:

- read-only analysis only
- do not modify files
- avoid generic "could be improved" advice
- if nothing worthwhile is found, explicitly say so
- if worthwhile work remains, rank the top 3 items by value and risk

Return:

1. current repo health in one sentence
2. top 3 actionable items
3. the single best next task for an implementation run
