import { ethers } from "hardhat";

/**
 * End-to-end test of the Uniswap v3 launch venue, run against a FORK of the
 * live Robinhood Chain so it exercises the real v3 factory, position manager,
 * router, and WETH:
 *
 *   FORK_URL=https://primehod.lol/api/rpc npx hardhat run scripts/testV3Launch.ts
 */
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const V3_NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

// tick(P) = log_1.0001(P). Starting FDV $5000 at $1790/ETH over 1B tokens.
function tickForUsdMcap(mcapUsd: number, ethUsd: number): number {
  const priceEth = mcapUsd / ethUsd / 1e9; // WETH per token
  const tick = Math.log(priceEth) / Math.log(1.0001);
  return Math.floor(tick);
}

async function main() {
  const [owner, creator, trader] = await ethers.getSigners();
  const ok = (c: boolean, m: string) => {
    if (!c) throw new Error("FAIL: " + m);
    console.log("  ok:", m);
  };

  const Factory = await ethers.getContractFactory("PrimehodFactory");
  const factory = await Factory.deploy(owner.address, owner.address, V3_FACTORY, V3_NPM, WETH);
  await factory.waitForDeployment();
  console.log("factory deployed on fork");

  // 1) Curve venue still works with the new Launch struct
  await (await factory.connect(creator).createToken("CurveTok", "CRV1", 200, 5000, "")).wait();
  const t0 = await factory.allTokens(0);
  const l0 = await factory.launchOf(t0);
  ok(Number(l0.venue) === 0 && l0.locker === ethers.ZeroAddress, "curve venue launch intact");
  const curve = await ethers.getContractAt("PrimehodCurve", l0.market);
  await (await curve.connect(trader).buy(0, { value: ethers.parseEther("0.01") })).wait();
  ok((await curve.ethRaised()) > 0n, "curve buy works");

  // 2) v3 venue launch
  const tick = tickForUsdMcap(5000, 1790);
  console.log("v3 launch at priceTick", tick);
  await (await factory.connect(creator).createTokenV3("V3Tok", "V3T", tick, "")).wait();
  const t1 = await factory.allTokens(1);
  const l1 = await factory.launchOf(t1);
  ok(Number(l1.venue) === 1, "v3 venue recorded");
  const pool = l1.market;
  const token = await ethers.getContractAt("PrimehodToken", t1);
  const poolBal = await token.balanceOf(pool);
  console.log("  pool token balance:", ethers.formatEther(poolBal));
  ok(poolBal > ethers.parseEther("790000000"), "~800M tokens sit in the v3 pool");

  // 3) locker holds the position NFT
  const locker = await ethers.getContractAt("PrimehodV3Locker", l1.locker);
  const tokenId = await locker.tokenId();
  ok(tokenId > 0n, "locker recorded position NFT " + tokenId);
  const npm = new ethers.Contract(V3_NPM, ["function ownerOf(uint256) view returns (address)"], ethers.provider);
  ok((await npm.ownerOf(tokenId)) === l1.locker, "position NFT owned by locker (locked)");

  // 4) trader buys via the real SwapRouter02 with plain ETH
  const router = new ethers.Contract(
    V3_ROUTER,
    [
      "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
    ],
    trader
  );
  await (
    await router.exactInputSingle(
      {
        tokenIn: WETH, tokenOut: t1, fee: 10000, recipient: trader.address,
        amountIn: ethers.parseEther("0.01"), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      },
      { value: ethers.parseEther("0.01") }
    )
  ).wait();
  const bought = await token.balanceOf(trader.address);
  console.log("  bought:", (Number(bought) / 1e18 / 1e6).toFixed(2), "M tokens for 0.01 ETH");
  ok(bought > 0n, "buy through public router works");

  // 5) trader sells back through the router
  await (await token.connect(trader).approve(V3_ROUTER, bought / 2n)).wait();
  await (
    await router.exactInputSingle(
      {
        tokenIn: t1, tokenOut: WETH, fee: 10000, recipient: trader.address,
        amountIn: bought / 2n, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      }
    )
  ).wait();
  const wethc = new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  const traderWeth = await wethc.balanceOf(trader.address);
  console.log("  got back:", ethers.formatEther(traderWeth), "WETH");
  ok(traderWeth > 0n, "sell through public router works");

  // 6) fees accrued -> locker.collect splits creator / platform 55/45
  const [c0, w0] = [await token.balanceOf(creator.address), await wethc.balanceOf(creator.address)];
  await (await locker.collect(t1 < WETH ? t1 : WETH, t1 < WETH ? WETH : t1)).wait();
  const creatorWeth = (await wethc.balanceOf(creator.address)) - w0;
  const platformWeth = await wethc.balanceOf(owner.address);
  const creatorTok = (await token.balanceOf(creator.address)) - c0;
  console.log("  creator fees:", ethers.formatEther(creatorWeth), "WETH +", ethers.formatEther(creatorTok), "tokens");
  console.log("  platform fees:", ethers.formatEther(platformWeth), "WETH");
  ok(creatorWeth > 0n, "creator received WETH LP fees");
  ok(platformWeth > 0n, "platform received WETH LP fees");
  const ratio = Number(creatorWeth) / (Number(creatorWeth) + Number(platformWeth));
  ok(Math.abs(ratio - 0.55) < 0.001, "fee split ~55/45 (" + (ratio * 100).toFixed(1) + "%)");

  // 7) locker has no rug path: NFT cannot leave
  const lockerFns = locker.interface.fragments.filter((f: any) => f.type === "function").map((f: any) => f.name);
  const bad = lockerFns.filter((n: string) => /withdraw|transfer|decrease|remove|migrate|rescue/i.test(n));
  ok(bad.length === 0, "locker exposes no liquidity-withdrawal function");

  console.log("\nAll v3 venue checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
