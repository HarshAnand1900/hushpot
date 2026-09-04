// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title TestConfidentialToken - a faucet-backed ERC-7984 for Sepolia and local tests
/// @notice A confidential token whose balances are encrypted, with an open faucet so
/// judges and testers can obtain some without asking anyone.
///
/// @dev Anyone may mint. That is deliberate for a testnet and would obviously never ship
/// to mainnet, where this is replaced by a real confidential stablecoin such as cUSDT.
contract TestConfidentialToken is ERC7984, ZamaEthereumConfig {
    /// @notice Most a single faucet call will hand out.
    uint64 public constant FAUCET_LIMIT = 100_000_000_000; // 100,000 tokens at 6 decimals

    constructor() ERC7984("Hushpot Test USD", "hUSD", "") {}

    /// @notice Mint test tokens to yourself.
    /// @param amount Plain amount to mint. Public by nature - it is a faucet, and the
    /// figure is visible in calldata regardless. Privacy begins once the tokens move.
    function faucet(uint64 amount) external {
        require(amount > 0 && amount <= FAUCET_LIMIT, "TestToken: bad faucet amount");

        euint64 minted = _mint(msg.sender, FHE.asEuint64(amount));
        FHE.allowThis(minted);
        FHE.allow(minted, msg.sender);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
