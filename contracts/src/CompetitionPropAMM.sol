// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPropAMMPeriphery} from "./interfaces/IPropAMMPeriphery.sol";

/// @title CompetitionPropAMM
/// @notice The reference market-making venue you deploy for the competition. It holds your CASH/ASSET
///         inventory and pays swaps out of its own balance.
/// @dev THIS CONTRACT IS THE COMPETITION SURFACE — do not modify it; modifying the venue is out of
///      scope and a modified venue will be rejected. You compete entirely OFF-CHAIN: the only lever
///      is `updatePrice(fairPrice, validUntil)`, which you call from the market-making bot in
///      ../market-making. The venue fills every swap at exactly `fairPrice` (WAD CASH per ASSET) —
///      there is no spread, no trade-size cap, and no inventory band. Your edge is quoting a better
///      price than rivals and keeping it fresh; a swap the venue can't cover simply reverts. PnL is
///      scored off-chain from your (wallet + venue) token balances marked at the official feed price.
contract CompetitionPropAMM is IPropAMMPeriphery, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;

    /// @notice The venue's entire quote: a fair price and the time it stays valid.
    /// @dev `fairPrice` is WAD-scaled CASH per ASSET (same scale as the market feed). A venue
    ///      deploys un-quoted (fairPrice = 0, validUntil = 0) and cannot fill until `updatePrice`.
    struct QuoteState {
        uint256 fairPrice;
        uint64 validUntil;
    }

    address public immutable CASH;
    address public immutable ASSET;
    string public teamName;

    QuoteState public quoteState;

    error InsufficientOutput(uint256 actual, uint256 minimum);
    error InvalidRange();
    error PairNotSupported(address tokenA, address tokenB);
    error QuoteExpired(uint256 timestamp, uint64 validUntil);
    error ZeroAmount();
    error ZeroAddress();

    /// @notice Emitted on every successful `updatePrice` call.
    event PriceUpdated(address indexed updater, uint256 fairPrice, uint64 validUntil);

    event Swap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        address receiver,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(string memory teamName_, address cash_, address asset_, address teamOwner_) Ownable(teamOwner_) {
        if (cash_ == address(0) || asset_ == address(0) || teamOwner_ == address(0)) {
            revert ZeroAddress();
        }

        teamName = teamName_;
        CASH = cash_;
        ASSET = asset_;
        // Intentionally left un-quoted: the venue cannot fill until the team calls updatePrice().
    }

    /// @notice Team-controlled quote update: set the fair price and its expiry, no validation.
    /// @param fairPrice WAD-scaled CASH per ASSET.
    /// @param validUntil Absolute unix timestamp the quote is honoured through.
    /// @dev `PriceUpdated` is emitted unconditionally on every call — even when the values are
    ///      unchanged from the previous quote, or zero. Off-chain scoring treats the event as the
    ///      canonical re-quote signal, so it is expected to fire on each call regardless of inputs.
    function updatePrice(uint256 fairPrice, uint64 validUntil) external onlyOwner {
        quoteState = QuoteState({fairPrice: fairPrice, validUntil: validUntil});
        emit PriceUpdated(msg.sender, fairPrice, validUntil);
    }

    /// @notice Owner may pull idle inventory out of the venue (e.g., between rounds).
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        IERC20(token).safeTransfer(to, amount);
    }

    function isSupportedPair(address tokenA, address tokenB) public view returns (bool) {
        return (tokenA == CASH && tokenB == ASSET) || (tokenA == ASSET && tokenB == CASH);
    }

    function getSupportedPairs(uint256 start, uint256 end) external view returns (TokenPair[] memory pairs) {
        if (start > end || end > 1) {
            revert InvalidRange();
        }

        pairs = new TokenPair[](end - start);
        if (start == 0 && end == 1) {
            pairs[0] = TokenPair({tokenA: CASH, tokenB: ASSET});
        }
    }

    function getPairListLength() external pure returns (uint256) {
        return 1;
    }

    function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, bytes memory extraData)
    {
        amountOut = _quote(tokenIn, tokenOut, amountIn);
        // No swap-time handshake: the venue re-quotes live in swap(), so no quote data needs carrying.
        extraData = "";
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address receiver,
        bytes calldata /* extraData */
    ) external returns (uint256 amountOut) {
        if (receiver == address(0)) {
            revert ZeroAddress();
        }

        // Re-quote live; the caller's minAmountOut is the only slippage guard.
        amountOut = _quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) {
            revert InsufficientOutput(amountOut, minAmountOut);
        }

        // Self-custody: pull input into the venue, pay output from the venue's own balance.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(receiver, amountOut);

        emit Swap(msg.sender, tokenIn, tokenOut, receiver, amountIn, amountOut);
    }

    /// @dev Both tokens share decimals and `fairPrice` is WAD CASH per ASSET, so the conversion is a
    ///      single mul-or-div: CASH in -> ASSET out divides by the price, ASSET in -> CASH out
    ///      multiplies by it. A freshly-deployed venue (validUntil = 0) reverts `QuoteExpired`, and a
    ///      trade too small to yield any output reverts `ZeroAmount`, so a swap never fills for nothing.
    function _quote(address tokenIn, address tokenOut, uint256 amountIn) private view returns (uint256 amountOut) {
        if (!isSupportedPair(tokenIn, tokenOut)) {
            revert PairNotSupported(tokenIn, tokenOut);
        }
        if (amountIn == 0) {
            revert ZeroAmount();
        }

        QuoteState memory current = quoteState;
        if (block.timestamp > current.validUntil) {
            revert QuoteExpired(block.timestamp, current.validUntil);
        }

        amountOut = tokenIn == CASH
            ? Math.mulDiv(amountIn, WAD, current.fairPrice) // CASH -> ASSET
            : Math.mulDiv(amountIn, current.fairPrice, WAD); // ASSET -> CASH

        // Reject dust that rounds down to nothing: a positive input must yield a positive output,
        // else a direct swap (the router passes per-route minAmountOut = 0) would pay zero for a real input.
        if (amountOut == 0) {
            revert ZeroAmount();
        }
    }
}
