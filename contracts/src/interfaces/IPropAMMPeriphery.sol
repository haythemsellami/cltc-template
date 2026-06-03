// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Standard adapter boundary consumed by the organizer's Monoper router. Your venue must
///         implement this exactly so the router can quote and route taker flow through it. The
///         reference `CompetitionPropAMM` already implements it — you do not need to touch this.
interface IPropAMMPeriphery {
    struct TokenPair {
        address tokenA;
        address tokenB;
    }

    function isSupportedPair(address tokenA, address tokenB) external view returns (bool);

    /// @notice Returns supported pairs in the half-open range [start, end).
    function getSupportedPairs(uint256 start, uint256 end) external view returns (TokenPair[] memory pairs);

    function getPairListLength() external view returns (uint256);

    /// @notice Cumulative exact-input quote for tokenIn -> tokenOut.
    /// @dev extraData must be valid input to swap for the quoted amount in the same transaction.
    function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, bytes memory extraData);

    /// @notice Executes an exact-input swap using quote data returned by getAmountOut.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address receiver,
        bytes calldata extraData
    ) external returns (uint256 amountOut);
}
