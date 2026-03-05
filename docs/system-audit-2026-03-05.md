# System Audit Report (2026-03-05)

## Scope and method

This audit pass focused on the full **code-level backtest execution path** and validation signals for realistic trading assumptions:

- data replay timing and event normalization
- order execution simulation
- fee/slippage consistency between entry and exit
- unit-test coverage for asset/address handling

## Iteration 1 findings

### 1) Entry slippage used raw `signal.asset` instead of resolved tradable symbol

- **Location**: `src/backtest/mockExecutor.ts`
- **Risk**: If a signal carries a token address (common from governance parsers), the liquidity-tier lookup falls back to default tier instead of the intended symbol tier.
- **Impact**: Potentially pessimistic or inconsistent execution assumptions depending on token.
- **Fix**: slippage now keys on `resolvedSymbol`.

### 2) Entry/exit slippage model mismatch for ARB and DYDX

- **Location**: `src/backtest/mockExecutor.ts` vs `src/backtest/resultCollector.ts`
- **Risk**: Entry and exit use different liquidity multipliers for the same instruments (`ARB`, `DYDX`).
- **Impact**: Distorted PnL and strategy robustness metrics due to model asymmetry.
- **Fix**: normalized `ARB` and `DYDX` exit multipliers to mirror entry model.

## Iteration 2 validation

Added a dedicated regression test to ensure that address-based and symbol-based signals produce identical execution assumptions for slippage.

- **Location**: `test/backtest/mockExecutor.test.ts`
- **Check**:
  - executes one signal with `asset='ARB'`
  - executes one with `asset=TOKENS.ARB` address
  - asserts equal `executedPrice` and equal `metadata.slippagePct`

## Residual risk notes (next iterations)

The following topics should be covered in follow-up hardening passes:

1. **Look-ahead safeguards around any interpolated pricing path** (`getInterpolatedPrice`) usage policies.
2. **Backtest/live parity matrix** for monitored Snapshot spaces/forums and synthetic protocol mappings.
3. **Time-quality assertions** (monotonicity, missing intervals, timezone normalization) at ingestion boundaries.
4. **Execution realism** enhancements:
   - latency buckets by source type (forum/snapshot/on-chain)
   - spread-dependent slippage
   - partial-fill simulation
5. **Statistical robustness governance**:
   - walk-forward parameter freezing checkpoints
   - minimum trade count thresholds for per-asset tuning
   - confidence intervals for Sharpe and PF.

