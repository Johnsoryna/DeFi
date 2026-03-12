# Agent Team For This Repository

This repository is a TypeScript DeFi governance trading bot, not a frontend application.
The useful sub-agents here are the ones that reduce context pollution while inspecting code paths, validating trading logic, checking live-order risk, and watching long-running jobs.
The active Codex registration lives in `.codex/config.toml`; the role-specific config layers currently loaded by Codex also live under `.codex/`.

## What The Project Does

- `src/monitor/*`: collect forum, Snapshot, whale, and on-chain governance events
- `src/analysis/*`: classify proposals, decode payloads, derive impacts
- `src/strategy/*`: generate signals, score confidence, size positions, apply risk rules
- `src/execution/*` and `src/clients/binance.ts`: place and maintain live futures orders
- `src/processing/*`: track positions, prices, and live portfolio state
- `src/backtest/*`: collect historical data, replay events, and produce reports
- `src/index.ts`: wires the live system end-to-end with intentional backtest/live parity

## Registered Roles

- `explorer`: read-only path tracing before edits
- `reviewer`: read-only correctness and regression review
- `quant_strategist`: read-only strategy and alpha specialist
- `execution_risk`: read-only live-execution and order-safety specialist
- `backtest_validator`: validation specialist for backtests and parity checks
- `ops_sre`: read-only deployment and runtime specialist
- `worker`: targeted implementation role
- `monitor`: long-running command and polling role

## Why This Set

- The roles are narrow and technical, which matches Codex multi-agent guidance.
- Read-heavy roles stay read-only to reduce edit conflicts.
- `worker` is the only registered implementation role that should usually patch code.
- `monitor` is included because this repo has long-running backtests, validators, and operational checks.
- UI-specific roles are intentionally omitted because this repo has no primary browser surface.
- Meta roles such as product owner or scrum master are intentionally omitted; the parent agent can orchestrate, while prioritization remains a human responsibility.

## Recommended Usage

For most code changes:

1. `explorer`
2. one specialist: `quant_strategist`, `execution_risk`, `backtest_validator`, or `ops_sre`
3. `worker`
4. `reviewer`

For long-running tasks:

1. `monitor`
2. `backtest_validator` or `ops_sre`

## Example Prompts

`Have explorer trace the affected path, execution_risk assess live-order risk, worker implement the smallest fix, and reviewer review the patch.`

`Use monitor to watch the backtest run, then ask backtest_validator to assess whether the result still supports the claimed behavior.`
