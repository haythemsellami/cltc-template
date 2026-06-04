// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {CompetitionPropAMM} from "../src/CompetitionPropAMM.sol";

/// Minimal mintable ERC20 standing in for the organizer's CASH / ASSET tokens.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A small starting suite proving the venue compiles and behaves. Extend it as you experiment —
/// e.g. assert the exact output your strategy expects at a given fairPrice.
contract CompetitionPropAMMTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant FAIR_PRICE = 1_000e18; // WAD CASH per ASSET
    uint64 internal constant TTL = 1 hours;

    address internal constant TEAM = address(0xA11CE);
    address internal constant TRADER = address(0xB0B);
    address internal constant RECEIVER = address(0xBEEF);

    MockERC20 internal cash;
    MockERC20 internal asset;

    function setUp() external {
        cash = new MockERC20("Competition Cash", "CASH");
        asset = new MockERC20("Competition Asset", "ASSET");
    }

    function _deployQuoted() internal returns (CompetitionPropAMM venue) {
        venue = new CompetitionPropAMM("team", address(cash), address(asset), TEAM);
        vm.prank(TEAM);
        venue.updatePrice(FAIR_PRICE, uint64(block.timestamp) + TTL);
    }

    function testQuoteBuyAndSellAtFairPrice() external {
        CompetitionPropAMM venue = _deployQuoted();
        // CASH -> ASSET divides by the price; ASSET -> CASH multiplies by it.
        (uint256 buyOut,) = venue.getAmountOut(address(cash), address(asset), 1_000e18);
        (uint256 sellOut,) = venue.getAmountOut(address(asset), address(cash), 1e18);
        assertEq(buyOut, 1e18, "buy quote");
        assertEq(sellOut, 1_000e18, "sell quote");
    }

    function testUpdatePriceChangesQuoteAndIsOwnerOnly() external {
        CompetitionPropAMM venue = _deployQuoted();
        (uint256 before,) = venue.getAmountOut(address(cash), address(asset), 1_000e18);
        assertEq(before, 1e18, "initial");

        vm.prank(TRADER);
        vm.expectRevert();
        venue.updatePrice(500e18, uint64(block.timestamp) + TTL);

        vm.prank(TEAM);
        venue.updatePrice(500e18, uint64(block.timestamp) + TTL);
        (uint256 afterPrice,) = venue.getAmountOut(address(cash), address(asset), 1_000e18);
        assertEq(afterPrice, 2e18, "halving the price doubles the ASSET out");
    }

    function testSwapMovesOwnerBalances() external {
        CompetitionPropAMM venue = _deployQuoted();
        // Inventory stays in YOUR wallet: mint to the owner and approve the venue (the bot does
        // this max-approve for you after deploying).
        asset.mint(TEAM, 100e18);
        vm.prank(TEAM);
        asset.approve(address(venue), type(uint256).max);

        cash.mint(TRADER, 1_000e18);
        vm.startPrank(TRADER);
        cash.approve(address(venue), 1_000e18);
        (uint256 quote, bytes memory extra) = venue.getAmountOut(address(cash), address(asset), 1_000e18);
        uint256 out = venue.swap(address(cash), address(asset), 1_000e18, quote, RECEIVER, extra);
        vm.stopPrank();

        assertEq(out, 1e18, "amountOut");
        assertEq(asset.balanceOf(RECEIVER), 1e18, "receiver got ASSET");
        assertEq(cash.balanceOf(TEAM), 1_000e18, "owner took CASH");
        assertEq(asset.balanceOf(TEAM), 99e18, "owner paid ASSET from its wallet");
        assertEq(cash.balanceOf(address(venue)), 0, "venue holds nothing");
        assertEq(asset.balanceOf(address(venue)), 0, "venue holds nothing");
    }

    function testSwapRevertsWithoutOwnerAllowance() external {
        CompetitionPropAMM venue = _deployQuoted();
        asset.mint(TEAM, 100e18); // owner is funded but never approved the venue

        cash.mint(TRADER, 1_000e18);
        vm.startPrank(TRADER);
        cash.approve(address(venue), 1_000e18);
        (uint256 quote, bytes memory extra) = venue.getAmountOut(address(cash), address(asset), 1_000e18);
        vm.expectRevert();
        venue.swap(address(cash), address(asset), 1_000e18, quote, RECEIVER, extra);
        vm.stopPrank();
    }

    function testUnquotedVenueReverts() external {
        // Freshly deployed: validUntil = 0, so any quote is expired.
        CompetitionPropAMM venue = new CompetitionPropAMM("team", address(cash), address(asset), TEAM);
        vm.expectRevert();
        venue.getAmountOut(address(cash), address(asset), 1_000e18);
    }

    function testStaleQuoteReverts() external {
        CompetitionPropAMM venue = new CompetitionPropAMM("team", address(cash), address(asset), TEAM);
        vm.prank(TEAM);
        venue.updatePrice(FAIR_PRICE, uint64(block.timestamp) + 10);
        vm.warp(block.timestamp + 11);
        vm.expectRevert();
        venue.getAmountOut(address(cash), address(asset), 1_000e18);
    }

    function testDustThatRoundsToZeroReverts() external {
        CompetitionPropAMM venue = _deployQuoted();
        // floor(999 * 1e18 / 1000e18) = 0 ASSET: must revert, not fill for nothing.
        vm.expectRevert(CompetitionPropAMM.ZeroAmount.selector);
        venue.getAmountOut(address(cash), address(asset), 999);
    }
}
