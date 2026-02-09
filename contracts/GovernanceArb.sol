// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GovernanceArb
 * @notice Flash loan arbitrage/liquidation contract for governance alpha strategies.
 *         Uses Balancer V2 flash loans (0% fee) as primary.
 *         Can fall back to Aave V3 flash loans (0.05% fee).
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
}

contract GovernanceArb is IFlashLoanRecipient {
    IVault public constant BALANCER_VAULT = IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    IPool public constant AAVE_POOL = IPool(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);

    address public immutable owner;

    // Action types for the callback
    uint8 constant ACTION_ARBITRAGE = 1;
    uint8 constant ACTION_RECURSIVE_LEVERAGE = 2;
    uint8 constant ACTION_LIQUIDATION = 3;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── Entry Points ───────────────────────────────────────────────

    /**
     * @notice Initiate a Balancer V2 flash loan (0% fee).
     * @param tokens Token addresses to borrow.
     * @param amounts Amounts to borrow.
     * @param data Encoded arbitrage/leverage instructions.
     */
    function executeFlashLoan(
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata data
    ) external onlyOwner {
        BALANCER_VAULT.flashLoan(this, tokens, amounts, data);
    }

    // ─── Balancer Flash Loan Callback ───────────────────────────────

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(BALANCER_VAULT), "Invalid caller");

        // Decode the action type
        uint8 actionType = abi.decode(userData, (uint8));

        if (actionType == ACTION_RECURSIVE_LEVERAGE) {
            _executeRecursiveLeverage(tokens, amounts, userData);
        } else if (actionType == ACTION_ARBITRAGE) {
            _executeArbitrage(tokens, amounts, userData);
        } else if (actionType == ACTION_LIQUIDATION) {
            _executeLiquidation(tokens, amounts, userData);
        }

        // Repay flash loan (fee is 0 for Balancer V2)
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 amountOwed = amounts[i] + feeAmounts[i];
            tokens[i].transfer(address(BALANCER_VAULT), amountOwed);
        }
    }

    // ─── Recursive Leverage Loop ────────────────────────────────────

    /**
     * @notice Flash borrow → deposit into Aave → borrow back → deposit again → repeat N times → repay.
     *         Achieves leveraged yield positions atomically.
     */
    function _executeRecursiveLeverage(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) internal {
        (, address asset, uint256 loops, uint256 borrowRatioBps) = abi.decode(
            userData,
            (uint8, address, uint256, uint256)
        );

        uint256 currentAmount = amounts[0];

        for (uint256 i = 0; i < loops; i++) {
            // Approve and supply to Aave
            IERC20(asset).approve(address(AAVE_POOL), currentAmount);
            AAVE_POOL.supply(asset, currentAmount, address(this), 0);

            // Borrow back a portion
            uint256 borrowAmount = (currentAmount * borrowRatioBps) / 10000;
            if (borrowAmount == 0) break;

            AAVE_POOL.borrow(asset, borrowAmount, 2, 0, address(this)); // 2 = variable rate
            currentAmount = borrowAmount;
        }

        // Final deposit of remaining borrowed amount
        if (currentAmount > 0) {
            IERC20(asset).approve(address(AAVE_POOL), currentAmount);
            AAVE_POOL.supply(asset, currentAmount, address(this), 0);
        }
    }

    // ─── Arbitrage Logic (placeholder) ──────────────────────────────

    function _executeArbitrage(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) internal {
        // Decode specific arbitrage instructions from userData
        // Implementation depends on the specific arb opportunity
        // E.g., DEX-to-DEX arb, liquidation arb, etc.
    }

    // ─── Liquidation Logic (placeholder) ────────────────────────────

    function _executeLiquidation(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) internal {
        // Decode liquidation target from userData
        // Call Aave liquidationCall or Compound absorb
    }

    // ─── Emergency Withdraw ─────────────────────────────────────────

    function emergencyWithdraw(IERC20 token) external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.transfer(owner, balance);
        }
    }

    function emergencyWithdrawETH() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "ETH transfer failed");
    }

    receive() external payable {}
}
