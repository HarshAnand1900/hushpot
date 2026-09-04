// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestERC20 - stand-in for the public USDTMock on Sepolia
/// @dev Local-only. On Sepolia the pool uses Zama's official `USDTMock`
/// (0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0), which likewise has an open `mint`.
contract TestERC20 is ERC20 {
    constructor() ERC20("Tether USD (Test)", "USDTTest") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet, exactly as the Sepolia mock does.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
