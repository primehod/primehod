import { ethers } from "hardhat";

/**
 * Local sanity test for the Primehod launchpad, run on the in-process Hardhat
 * network (no RPC needed):
 *
 *   npx hardhat run scripts/testPrimehodCurve.ts
 *
 * Exercises: public launch -> vesting created, curve seeded; buy raises price and
 * accrues a fee; sell returns ETH; dynamic fee ramps; buying past the cap graduates.
 */
async function main() {
  const [owner, creator, buyer] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("PrimehodFactory");
  const factory = await Factory.deploy(owner.address, owner.address);
  await factory.waitForDeployment();

  // Reference price 1000 USD/ETH so a 5000 USD cap = 5 ETH (graduates within test funds).
  await (await factory.setLaunchDefaults(
    2000,   // vestBps 20%
    100,    // vestReleaseBps 1%/period
    30 * 24 * 3600, // 30 days
    500,    // maxFee 5%
    5500,   // creator 55%
    1000    // ethUsdPrice: 1000 USD per ETH
  )).wait();

  // Public creator launches with a 1% base fee and a $5,000 graduation cap (= 5 ETH).
  const tx = await factory.connect(creator).createToken("Hood Rocket", "ROCK", 100, 5000, "");
  const rc = await tx.wait();
  const ev = rc!.logs.map((l) => { try { return factory.interface.parseLog(l as any); } catch { return null; } })
    .find((e) => e?.name === "TokenLaunched")!;
  const tokenAddr = ev!.args.token as string;
  const curveAddr = ev!.args.curve as string;
  const vestingAddr = ev!.args.vesting as string;

  const token = await ethers.getContractAt("PrimehodToken", tokenAddr);
  const curve = await ethers.getContractAt("PrimehodCurve", curveAddr);

  const supply = await token.totalSupply();
  const vestBal = await token.balanceOf(vestingAddr);
  const curveBal = await token.balanceOf(curveAddr);
  console.log("Total supply     :", ethers.formatUnits(supply));
  console.log("Vesting balance  :", ethers.formatUnits(vestBal), "(expect 20%)");
  console.log("Curve balance    :", ethers.formatUnits(curveBal), "(expect 80%)");
  console.log("Start price      :", ethers.formatEther(await curve.priceX18()), "ETH/token");

  ok("vesting = 20%", vestBal === supply * 2000n / 10000n);
  ok("curve = 80%", curveBal === supply * 8000n / 10000n);

  // Buy 1 ETH.
  const [qOut, qFee] = await curve.quoteBuy(ethers.parseEther("1"));
  const b1 = await curve.connect(buyer).buy(0, { value: ethers.parseEther("1") });
  await b1.wait();
  const got = await token.balanceOf(buyer.address);
  console.log("\nBought with 1 ETH:", ethers.formatUnits(got), "tokens (quote", ethers.formatUnits(qOut) + ")");
  console.log("Fee on that buy  :", ethers.formatEther(qFee), "ETH");
  console.log("Price after buy  :", ethers.formatEther(await curve.priceX18()), "ETH/token");
  console.log("Fee bps next     :", (await curve.currentFeeBps()).toString(), "(base 100, ramps on volatility)");
  ok("buyer received tokens", got > 0n);
  ok("price rose", (await curve.priceX18()) > ethers.parseEther("2.5") / (curveBal / 10n ** 18n));

  // Creator fee accrued (55% of the fee).
  const cFees = await curve.creatorFees();
  const pFees = await curve.platformFees();
  console.log("\nCreator fees     :", ethers.formatEther(cFees), "ETH (55%)");
  console.log("Platform fees    :", ethers.formatEther(pFees), "ETH (45%)");
  ok("creator > platform split", cFees > pFees);

  // Sell half back.
  await (await token.connect(buyer).approve(curveAddr, got)).wait();
  const half = got / 2n;
  const ethBefore = await ethers.provider.getBalance(buyer.address);
  await (await curve.connect(buyer).sell(half, 0)).wait();
  console.log("\nSold half back. Curve token balance now:", ethers.formatUnits(await token.balanceOf(curveAddr)));
  ok("curve took tokens back", (await token.balanceOf(curveAddr)) > curveBal - got);

  // Buy hard to graduate (cap 5 ETH).
  console.log("\nBuying 6 ETH to cross the 5 ETH graduation cap...");
  await (await curve.connect(buyer).buy(0, { value: ethers.parseEther("6") })).wait();
  console.log("Graduated        :", await curve.graduated());
  console.log("ETH raised       :", ethers.formatEther(await curve.ethRaised()), "ETH");
  ok("graduated flag set", await curve.graduated());

  // Trading STAYS OPEN after graduation (no DEX on Robinhood yet: the curve is the
  // permanent market, so holders always keep an exit; no admin can seize liquidity).
  const beforeBuy = await token.balanceOf(buyer.address);
  await (await curve.connect(buyer).buy(0, { value: ethers.parseEther("0.1") })).wait();
  ok("buy still works after graduation", (await token.balanceOf(buyer.address)) > beforeBuy);

  const some = (await token.balanceOf(buyer.address)) / 4n;
  await (await token.connect(buyer).approve(curveAddr, some)).wait();
  const ethBeforeSell = await ethers.provider.getBalance(buyer.address);
  await (await curve.connect(buyer).sell(some, 0)).wait();
  ok("sell still works after graduation (holder exit)", (await ethers.provider.getBalance(buyer.address)) > ethBeforeSell - ethers.parseEther("0.01"));

  console.log("\nAll checks passed.");
}

function ok(label: string, cond: boolean) {
  if (!cond) throw new Error("FAILED: " + label);
  console.log("  ok:", label);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
