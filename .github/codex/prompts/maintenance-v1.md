Work on branch `v1` of this repository and make the single highest-value safe improvement you can justify.

This repository is a DeFi governance trading bot, so prefer this order:

1. fix a build blocker
2. fix a critical live-trading safety bug
3. fix a backtest/live parity bug
4. add a missing high-value validation around execution or risk

Use specialist subagents as needed:

- `explorer`
- `execution_risk`
- `backtest_validator`
- `ops_sre`
- `worker`

Constraints:

- make the smallest defensible change
- keep unrelated files untouched
- do not chase low-value cleanup
- validate only the behavior you changed
- if no worthwhile change is justified, leave the worktree unchanged and explain why

Output:

- what you changed
- why it matters
- what validation you ran
- residual risk, if any
