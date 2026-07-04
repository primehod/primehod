import { ethers, network } from "hardhat";

/**
 * Deploys the Primehod launchpad factory to the configured network.
 *
 *   npx hardhat run scripts/deployPrimehod.ts --network robinhood-mainnet
 *
 * Requires a working RPC connection (set ROBINHOOD_MAINNET_RPC_URL to the
 * primehod.lol/api/rpc proxy if your ISP blocks the Robinhood Chain RPC)
 * and a funded PRIVATE_KEY in contracts/.env.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log("Network      :", network.name);
  console.log("Deployer     :", deployer.address);
  console.log("Balance      :", ethers.formatEther(bal), "ETH");
  if (bal === 0n) {
    throw new Error("Deployer has 0 ETH. Bridge ETH to Robinhood Chain first.");
  }

  // owner = deployer, platform fee recipient = deployer (change with setPlatform).
  const Factory = await ethers.getContractFactory("PrimehodFactory");
  const factory = await Factory.deploy(deployer.address, deployer.address);
  await factory.waitForDeployment();

  const addr = await factory.getAddress();
  console.log("\nPrimehodFactory deployed:", addr);
  console.log("\nLaunch defaults:");
  console.log("  vestBps          :", (await factory.vestBps()).toString(), "(20% vested)");
  console.log("  vestReleaseBps   :", (await factory.vestReleaseBps()).toString(), "(1%/period)");
  console.log("  vestPeriod       :", (await factory.vestPeriod()).toString(), "sec");
  console.log("  dynamicMaxFeeBps :", (await factory.dynamicMaxFeeBps()).toString(), "(5% ceiling)");
  console.log("  creatorSplitBps  :", (await factory.creatorSplitBps()).toString(), "(creator 55%)");
  console.log("  ethUsdPrice      :", (await factory.ethUsdPrice()).toString(), "USD/ETH (owner-settable)");
  console.log("  cap $5k  ->", ethers.formatEther(await factory.capForUsd(5000)), "ETH");
  console.log("  cap $10k ->", ethers.formatEther(await factory.capForUsd(10000)), "ETH");
  console.log("  cap $20k ->", ethers.formatEther(await factory.capForUsd(20000)), "ETH");
  console.log("\nNext: createToken(name, symbol, baseFeeBps, graduationUsd) to launch.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
