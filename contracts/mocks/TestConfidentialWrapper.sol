// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @title TestConfidentialWrapper — local stand-in for Zama's cUSDTMock
/// @dev Local-only. On Sepolia the pool uses Zama's official `cUSDTMock`
/// (0x4E7B06D78965594eB5EF5414c357ca21E1554491), which is this same OpenZeppelin
/// wrapper — verified on-chain: rate 1, 6 decimals, underlying USDTMock.
///
/// Deploying the identical implementation locally means the auto-shield path is tested
/// against the real thing rather than an approximation.
contract TestConfidentialWrapper is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(
        IERC20 underlying_
    ) ERC7984("Confidential Test USD", "cUSDTTest", "") ERC7984ERC20Wrapper(underlying_) {}
}
