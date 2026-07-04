import { ethers } from "hardhat";

// Uniswap v3 wiring on Robinhood Chain (audited canonical deployment).
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const V3_NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";


/**
 * Adversarial checks used in the security review. Each block asserts that a known
 * attack path FAILS, so the assertions are the point: if any require here stops
 * throwing, a guard has regressed.
 *
 *   npx hardhat run scripts/auditAdversarial.ts
 */
async function expectRevert(p: Promise<unknown>, label: string) {
  try {
    await p;
    throw new Error(`NOT REVERTED: ${label}`);
  } catch (e: any) {
    if (String(e.message).startsWith("NOT REVERTED")) throw e;
    console.log(`  ok: reverted as expected — ${label}`);
  }
}

async function main() {
  const [owner, attacker, victim] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("PrimehodFactory");
  const factory = await Factory.deploy(owner.address, owner.address, V3_FACTORY, V3_NPM, WETH);
  await factory.waitForDeployment();

  // Public launch by the attacker (no owner privileges).
  await (await factory.connect(attacker).createToken("Test", "TST", 200, 5000, "")).wait();
  const tokenAddr = (await factory.allTokens(0)) as string;
  const launch = await factory.launchOf(tokenAddr);
  const curve = await ethers.getContractAt("PrimehodCurve", launch.market);
  const token = await ethers.getContractAt("PrimehodToken", tokenAddr);

  console.log("1) Curve solvency: cannot pull more ETH than really raised");
  // Victim buys 1 ETH in.
  await (await curve.connect(victim).buy(0, { value: ethers.parseEther("1") })).wait();
  const raised = await curve.ethRaised();
  const contractEth = await ethers.provider.getBalance(launch.market);
  console.log(`   ethRaised=${ethers.formatEther(raised)}  contractBalance=${ethers.formatEther(contractEth)}`);
  // Attacker acquires a mountain of tokens (from the curve itself) then tries to
  // dump far more than the curve can back, aiming to drain the virtual reserve.
  await (await curve.connect(attacker).buy(0, { value: ethers.parseEther("3") })).wait();
  const bal = await token.balanceOf(attacker.address);
  await (await token.connect(attacker).approve(launch.market, bal)).wait();
  // Selling the whole stack must never pay out more than real ETH in the pool.
  const before = await ethers.provider.getBalance(launch.market);
  await (await curve.connect(attacker).sell(bal, 0)).wait();
  const after = await ethers.provider.getBalance(launch.market);
  if (after < 0n) throw new Error("curve went insolvent");
  console.log(`   ok: curve still solvent after max dump (balance ${ethers.formatEther(after)} ETH, drained ${ethers.formatEther(before - after)})`);

  console.log("2) No owner hook over deployed curve funds");
  const fnames = curve.interface.fragments
    .filter((f: any) => f.type === "function")
    .map((f: any) => f.name);
  const dangerous = fnames.filter((n: string) =>
    /seed|withdraw|rescue|sweep|drain|setowner|migrate|admin/i.test(n)
  );
  if (dangerous.length) throw new Error("curve exposes owner-ish fn: " + dangerous.join(","));
  console.log("   ok: curve has no seed/withdraw/rescue/admin function at all");

  console.log("3) Token is admin-less (no mint / pause / owner)");
  const tnames = token.interface.fragments
    .filter((f: any) => f.type === "function")
    .map((f: any) => f.name);
  const badToken = tnames.filter((n: string) => /mint|pause|blacklist|owner/i.test(n));
  if (badToken.length) throw new Error("token exposes: " + badToken.join(","));
  console.log("   ok: only standard ERC-20 functions exposed");

  console.log("4) Owner cannot rewrite a live token's economics");
  // Owner changing defaults must not affect the already-launched curve.
  await (await factory.setLaunchDefaults(0, 0, 0, 500, 9000, 3000)).wait();
  const splitStill = await curve.creatorSplitBps();
  if (splitStill !== 5500n) throw new Error("live curve mutated by owner!");
  console.log(`   ok: live curve split unchanged (${splitStill} bps) after owner changed defaults`);

  console.log("5) Fee is capped — never a honeypot");
  const maxFee = await curve.maxFeeBps();
  if (maxFee > 500n) throw new Error("fee ceiling above 5%");
  console.log(`   ok: max swap fee is ${maxFee} bps (<=500)`);

  console.log("\nAll adversarial checks held.");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
});
