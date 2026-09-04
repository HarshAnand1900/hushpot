import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { addressesFor } from "../config/addresses";

/**
 * Deploys Hushpot.
 *
 * On a network with known token addresses (Sepolia) the pool is pointed at Zama's
 * official confidential USDT mock, so judges and anyone from an earlier season already
 * hold the token and its open faucet is the underlying's public `mint`.
 *
 * Anywhere else - a local node - the token pair is deployed first, using the same
 * OpenZeppelin wrapper implementation that sits behind the Sepolia mock.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;

  const chainId = Number(await hre.getChainId());
  const known = addressesFor(chainId);

  let confidentialToken: string;
  let underlying: string;

  if (known) {
    confidentialToken = known.confidentialToken;
    underlying = known.underlyingToken;
    log(`Using Zama's official confidential token`);
    log(`  cUSDTMock  ${confidentialToken}`);
    log(`  USDTMock   ${underlying}  (open mint - this is the faucet)`);
  } else {
    log(`No known tokens for chain ${chainId} - deploying a local pair`);

    const usdt = await deploy("TestERC20", { from: deployer, log: true });
    const wrapper = await deploy("TestConfidentialWrapper", {
      from: deployer,
      args: [usdt.address],
      log: true,
    });

    confidentialToken = wrapper.address;
    underlying = usdt.address;
  }

  const pool = await deploy("HushpotPool", {
    from: deployer,
    args: [confidentialToken],
    log: true,
  });

  log("");
  log(`HushpotPool        ${pool.address}`);
  log(`  token            ${confidentialToken}`);
  log(`  underlying       ${underlying}`);
  log("");
  log(`Next: fund the prize reserve, then run a draw.`);
  log(`  npx hardhat hushpot:fund --amount 1000000 --network ${hre.network.name}`);
  log(`  npx hardhat hushpot:status --network ${hre.network.name}`);
};

export default func;
func.id = "deploy_hushpot";
func.tags = ["Hushpot"];
