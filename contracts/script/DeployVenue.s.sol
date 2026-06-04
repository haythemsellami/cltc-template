// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CompetitionPropAMM} from "../src/CompetitionPropAMM.sol";

/// @notice Optional manual deploy of your venue via Foundry. Also max-approves the venue for CASH
///         and ASSET — the venue holds no inventory; it settles swaps against your wallet through
///         these allowances.
/// @dev The recommended path is the market-making bot (`cd ../market-making && npm start`), which
///      deploys, approves, registers, and quotes in one command. Use this script only if you want
///      to deploy by hand — afterwards run the bot with `VENUE=<address>` to register/quote it.
///
///      Required env:
///        PRIVATE_KEY  - your funded deployer key (also becomes the venue owner)
///        CASH         - the round's CASH token address (from the operator manifest / dashboard)
///        ASSET        - the round's ASSET token address
///        TEAM_NAME    - your team name (optional, defaults to "my-team")
///
///      Example:
///        PRIVATE_KEY=0x.. CASH=0x.. ASSET=0x.. TEAM_NAME=alpha \
///          forge script script/DeployVenue.s.sol:DeployVenue --rpc-url "$RPC_URL" --broadcast
contract DeployVenue is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(deployerKey);
        address cash = vm.envAddress("CASH");
        address asset = vm.envAddress("ASSET");
        string memory teamName = vm.envOr("TEAM_NAME", string("my-team"));

        vm.startBroadcast(deployerKey);
        CompetitionPropAMM venue = new CompetitionPropAMM(teamName, cash, asset, owner);
        // Inventory stays in your wallet: the venue needs allowances to settle swaps against it.
        IERC20(cash).approve(address(venue), type(uint256).max);
        IERC20(asset).approve(address(venue), type(uint256).max);
        vm.stopBroadcast();

        console2.log("CompetitionPropAMM deployed (un-quoted) + max-approved for CASH/ASSET:", address(venue));
        console2.log("owner:", owner);
        console2.log("Next: register it, then call updatePrice. The market-making bot does both");
        console2.log("for you:  VENUE=%s npm start", address(venue));
    }
}
