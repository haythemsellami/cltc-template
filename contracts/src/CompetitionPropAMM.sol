// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPropAMMPeriphery} from "./interfaces/IPropAMMPeriphery.sol";

/// @title CompetitionPropAMM
/// @notice A reference market-making venue for the competition — it works out of the box and is yours
///         to improve. It holds NO inventory: your CASH/ASSET stay in YOUR wallet, and the venue
///         settles swaps against your wallet through the allowances you grant it.
/// @dev THIS IS A STARTING POINT, NOT A FIXED RULE. Deploy it as-is, or change anything: the pricing
///      curve, a spread/skew, the fill logic, inventory management, the expiry policy (or no expiry).
///      The ONLY hard requirement is that your venue keeps implementing `IPropAMMPeriphery` so the
///      organizer's Monoper router can call `getAmountOut`/`swap` and route flow to it, and that you
///      register it. As shipped: after deploying you max-approve the venue for CASH and ASSET (the
///      bot does this); a swap then pulls `tokenIn` from the caller to your wallet and pays
///      `tokenOut` from your wallet to the receiver. A quote is a `fairPrice` (WAD CASH per ASSET)
///      valid until `validUntil`, and the venue quotes a symmetric spread around it — buyers pay the
///      ask = fair·(1 + spread/2), sellers receive the bid = fair·(1 − spread/2) — so it earns from
///      two-way flow instead of filling everyone at mid. The spread defaults to 20 bps and you retune
///      it with `setSpreadBps` (or set 0 to quote at mid). There is no size cap or inventory band,
///      and a fill your wallet can't cover reverts. Switching venues
///      mid-round is deploy -> approve -> re-register: your inventory never moves. The off-chain bot
///      in ../market-making decides what price to publish and when. PnL is scored off-chain from
///      your wallet's token balances marked at the official feed price, minus the gas you spend —
///      that is the only rule.
contract CompetitionPropAMM is IPropAMMPeriphery, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    /// @notice Basis-points denominator (1e4 = 100%).
    uint256 public constant BPS = 10_000;
    /// @notice Spread applied to a freshly deployed venue, in bps of round-trip cost.
    uint256 public constant DEFAULT_SPREAD_BPS = 20;
    /// @notice Upper bound on a settable spread (sanity guard): 20% round-trip.
    uint256 public constant MAX_SPREAD_BPS = 2_000;

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

    /// @notice Symmetric quote spread in bps; half is applied to each side of the fair price. The
    ///         venue earns it from uninformed two-way flow and loses it to informed flow. Owner-set
    ///         via `setSpreadBps`; defaults to `DEFAULT_SPREAD_BPS`. Set it to 0 to quote at mid.
    uint256 public spreadBps;

    error InsufficientOutput(uint256 actual, uint256 minimum);
    error InvalidRange();
    error SpreadTooWide(uint256 spreadBps, uint256 maxSpreadBps);
    error PairNotSupported(address tokenA, address tokenB);
    error QuoteExpired(uint256 timestamp, uint64 validUntil);
    error ZeroAmount();
    error ZeroAddress();

    /// @notice Emitted on every successful `updatePrice` call.
    event PriceUpdated(address indexed updater, uint256 fairPrice, uint64 validUntil);

    /// @notice Emitted on every successful `setSpreadBps` call.
    event SpreadUpdated(address indexed updater, uint256 spreadBps);

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
        spreadBps = DEFAULT_SPREAD_BPS;
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

    /// @notice Team-controlled spread update: set the symmetric quote spread (bps of round-trip cost).
    /// @param newSpreadBps Round-trip spread in bps; half is applied to each side. 0 quotes at mid.
    /// @dev Capped at `MAX_SPREAD_BPS`. Independent of the price quote, so retuning the spread does
    ///      not require (or invalidate) the current `updatePrice` quote. Tune this as a core lever —
    ///      or rip it out and price however you like; the only hard rule is `IPropAMMPeriphery`.
    function setSpreadBps(uint256 newSpreadBps) external onlyOwner {
        if (newSpreadBps > MAX_SPREAD_BPS) {
            revert SpreadTooWide(newSpreadBps, MAX_SPREAD_BPS);
        }
        spreadBps = newSpreadBps;
        emit SpreadUpdated(msg.sender, newSpreadBps);
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

        // Inventory lives with the owner (you): input goes to your wallet, output is paid from your
        // wallet via the allowance you granted this venue after deploying.
        address inventory = owner();
        IERC20(tokenIn).safeTransferFrom(msg.sender, inventory, amountIn);
        IERC20(tokenOut).safeTransferFrom(inventory, receiver, amountOut);

        emit Swap(msg.sender, tokenIn, tokenOut, receiver, amountIn, amountOut);
    }

    /// @dev Both tokens share decimals and `fairPrice` is WAD CASH per ASSET, so the conversion is a
    ///      single mul-or-div around the price, with half the spread applied to the relevant side:
    ///      CASH in -> ASSET out divides by the ask (fair·(BPS + half)/BPS); ASSET in -> CASH out
    ///      multiplies by the bid (fair·(BPS − half)/BPS). A round-trip therefore costs `spreadBps`,
    ///      and a zero spread reduces to a plain fill at the fair price. A freshly-deployed venue
    ///      (validUntil = 0) reverts `QuoteExpired`, and a trade too small to yield any output reverts
    ///      `ZeroAmount`, so a swap never fills for nothing.
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

        uint256 half = spreadBps / 2; // half-spread per side, in bps
        amountOut = tokenIn == CASH
            ? Math.mulDiv(amountIn, WAD * BPS, current.fairPrice * (BPS + half)) // CASH -> ASSET (ask)
            : Math.mulDiv(amountIn, current.fairPrice * (BPS - half), WAD * BPS); // ASSET -> CASH (bid)

        // Reject dust that rounds down to nothing: a positive input must yield a positive output,
        // else a direct swap (the router passes per-route minAmountOut = 0) would pay zero for a real input.
        if (amountOut == 0) {
            revert ZeroAmount();
        }
    }
}
