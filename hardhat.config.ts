import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat default

// Robinhood Chain mainnet (Arbitrum L2). Verified live: chainId 4663.
const ROBINHOOD_MAINNET_RPC =
  process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      // "paris" avoids PUSH0/MCOPY/transient-storage opcodes that a brand-new
      // chain may not support yet. Safe everywhere; bump to shanghai/cancun once
      // Robinhood Chain's supported EVM version is confirmed.
      evmVersion: "paris",
      viaIR: true,
      debug: { revertStrings: "strip" },
    },
  },
  networks: {
    // Primehod production network: Robinhood Chain mainnet.
    "robinhood-mainnet": {
      url: ROBINHOOD_MAINNET_RPC,
      accounts: [PRIVATE_KEY],
      chainId: 4663,
    },
  },
  etherscan: {
    apiKey: process.env.EXPLORER_API_KEY || "",
  },
  sourcify: {
    enabled: false,
  },
};

export default config;
