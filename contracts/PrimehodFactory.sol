// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./PrimehodToken.sol";
import "./PrimehodVesting.sol";
import "./PrimehodCurve.sol";

/**
 * @title PrimehodFactory
 * @notice Launches a token in one transaction on Robinhood Chain: mints a fixed,
 *         admin-less ERC-20, splits the supply, and wires up a self-contained
 *         bonding curve. This is the Robinhood-Chain port of the B20 launchpad,
 *         with the Base-native precompile and Uniswap v4 pool replaced by a plain
 *         ERC-20 (PrimehodToken) and an ETH bonding curve (PrimehodCurve).
 *
 *         Supply split per launch (1,000,000,000 tokens, fully minted):
 *           - Owner launches WITH a distribution set  -> that slice is sent to the
 *             team/treasury wallets instantly, no vesting (owner-only path).
 *           - Everyone else (public creators)         -> the vesting slice (default
 *             20%) unlocks 1% of supply per 30 days to the creator.
 *           - The remainder is seeded into the bonding curve for open trading.
 *
 *         The swap fee (base -> max), fee split, vesting schedule, virtual-reserve
 *         seeding and graduation cap are all owner-editable DEFAULTS that apply to
 *         FUTURE launches only; once a token launches its economics are immutable.
 */
contract PrimehodFactory is Ownable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e18; // 1B, fully minted & capped
    uint8 public constant DECIMALS = 18;
    uint256 public constant MAX_DIST_RECIPIENTS = 50;

    // ── Launch DEFAULTS (owner-editable; apply to FUTURE launches only) ───────────

    // Vesting: `vestBps` of supply reserved, `vestReleaseBps` released per `vestPeriod`
    // to the creator. Default 20% released 1%/30d = 20 periods. vestBps = 0 disables it.
    uint256 public vestBps = 2000;        // 20% of supply vested
    uint256 public vestReleaseBps = 100;  // 1% of supply unlocked per period
    uint256 public vestPeriod = 30 days;  // period length

    // Swap fee: launcher's chosen fee is the BASE; this is the dynamic MAX ceiling.
    uint256 public dynamicMaxFeeBps = 500; // 5%
    // Creator's cut of each collected swap fee, out of 10000 (default 55%).
    uint256 public creatorSplitBps = 5500;

    // Graduation cap is chosen per launch as a USD target (e.g. 5000, 10000, 20000)
    // and converted to an ETH amount using `ethUsdPrice` (whole USD per 1 ETH), which
    // the owner keeps in line with the market. The curve seeds initialVirtualEth =
    // cap/4 automatically, so ~80% of supply sells before a token graduates, at any cap.
    uint256 public ethUsdPrice = 3000;      // USD per 1 ETH (owner-settable)
    uint256 public constant MIN_CAP_USD = 1000;
    uint256 public constant MAX_CAP_USD = 10_000_000;

    // Platform fee recipient (defaults to the owner).
    address public platform;

    // Owner-only instant distribution (no vesting). distBps[i] is that address's
    // share of TOTAL_SUPPLY in bps. Empty, or a non-owner launcher, => public vesting.
    address[] public distRecipients;
    uint256[] public distBps;

    struct Launch {
        address token;
        address curve;
        address vesting;   // 0 if the owner-instant path was used
        address creator;
    }
    mapping(address => Launch) public launchOf; // token => Launch
    // token => off-chain metadata URI (Irys/Arweave JSON: image, description, links).
    // Empty string is allowed; the UI falls back to a generated identicon.
    mapping(address => string) public metadataOf;
    address[] public allTokens;

    event LaunchDefaultsUpdated(
        uint256 vestBps,
        uint256 vestReleaseBps,
        uint256 vestPeriod,
        uint256 dynamicMaxFeeBps,
        uint256 creatorSplitBps,
        uint256 ethUsdPrice
    );
    event DistributionSet(uint256 count, uint256 totalBps);
    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address curve,
        address vesting,
        uint256 baseFeeBps
    );

    constructor(address _owner, address _platform) Ownable(_owner) {
        platform = _platform == address(0) ? _owner : _platform;
    }

    // ── Owner config ─────────────────────────────────────────────────────────────

    function setLaunchDefaults(
        uint256 _vestBps,
        uint256 _vestReleaseBps,
        uint256 _vestPeriod,
        uint256 _dynamicMaxFeeBps,
        uint256 _creatorSplitBps,
        uint256 _ethUsdPrice
    ) external onlyOwner {
        require(_vestBps <= 10000, "vestBps>100%");
        require(_vestBps == 0 || (_vestReleaseBps > 0 && _vestReleaseBps <= _vestBps), "bad release");
        require(_vestBps == 0 || _vestPeriod > 0, "bad period");
        require(_dynamicMaxFeeBps >= 100 && _dynamicMaxFeeBps <= 500, "max fee out of range");
        require(_creatorSplitBps <= 10000, "split>100%");
        require(_ethUsdPrice > 0, "zero price");

        vestBps = _vestBps;
        vestReleaseBps = _vestReleaseBps;
        vestPeriod = _vestPeriod;
        dynamicMaxFeeBps = _dynamicMaxFeeBps;
        creatorSplitBps = _creatorSplitBps;
        ethUsdPrice = _ethUsdPrice;

        emit LaunchDefaultsUpdated(
            _vestBps, _vestReleaseBps, _vestPeriod, _dynamicMaxFeeBps,
            _creatorSplitBps, _ethUsdPrice
        );
    }

    /// @notice Update the ETH/USD reference used to convert USD graduation caps to ETH.
    function setEthUsdPrice(uint256 _ethUsdPrice) external onlyOwner {
        require(_ethUsdPrice > 0, "zero price");
        ethUsdPrice = _ethUsdPrice;
    }

    /// @notice The ETH graduation cap (wei) a given USD target maps to right now.
    function capForUsd(uint256 graduationUsd) public view returns (uint256) {
        return (graduationUsd * 1e18) / ethUsdPrice;
    }

    function setPlatform(address _platform) external onlyOwner {
        require(_platform != address(0), "zero platform");
        platform = _platform;
    }

    /// @notice Configure the owner-instant distribution used when the OWNER launches.
    ///         Pass empty arrays to clear it (back to the public vesting default).
    function setDistribution(address[] calldata recipients, uint256[] calldata bps) external onlyOwner {
        require(recipients.length == bps.length, "length mismatch");
        require(recipients.length <= MAX_DIST_RECIPIENTS, "too many");
        uint256 total;
        for (uint256 i = 0; i < bps.length; i++) {
            require(recipients[i] != address(0), "zero recipient");
            total += bps[i];
        }
        require(total <= 10000, "dist>100%");
        distRecipients = recipients;
        distBps = bps;
        emit DistributionSet(recipients.length, total);
    }

    // ── Launch ───────────────────────────────────────────────────────────────────

    /// @notice Launch a token. `baseFeeBps` is the resting swap fee (1%-5%); it ramps
    ///         up to `dynamicMaxFeeBps` under volatility. Vesting or owner-instant
    ///         distribution is chosen automatically from the caller and current config.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint256 baseFeeBps,
        uint256 graduationUsd,
        string calldata metadataURI
    ) external returns (address token, address curve) {
        require(baseFeeBps >= 100 && baseFeeBps <= dynamicMaxFeeBps, "base fee out of range");
        require(graduationUsd >= MIN_CAP_USD && graduationUsd <= MAX_CAP_USD, "cap out of range");

        // Convert the USD graduation target to an ETH cap, and seed the curve so
        // ~80% of supply sells before graduation regardless of the chosen cap.
        uint256 graduationCap = capForUsd(graduationUsd);
        uint256 initialVirtualEth = graduationCap / 4;
        require(initialVirtualEth > 0, "cap too small");

        // Full supply is minted to this factory, then split below.
        PrimehodToken t = new PrimehodToken(name, symbol, DECIMALS, TOTAL_SUPPLY, address(this));
        token = address(t);

        uint256 allocated;
        address vesting = address(0);
        bool ownerInstant = (msg.sender == owner()) && (distRecipients.length > 0);

        if (ownerInstant) {
            // Owner path: mint the configured slices to team/treasury instantly.
            for (uint256 i = 0; i < distRecipients.length; i++) {
                uint256 amt = (TOTAL_SUPPLY * distBps[i]) / 10000;
                if (amt > 0) {
                    allocated += amt;
                    require(t.transfer(distRecipients[i], amt), "dist transfer failed");
                }
            }
        } else if (vestBps > 0) {
            // Public path: vest a slice to the creator, 1%/period.
            uint256 vestAmount = (TOTAL_SUPPLY * vestBps) / 10000;
            uint256 releasePerPeriod = (TOTAL_SUPPLY * vestReleaseBps) / 10000;
            PrimehodVesting v = new PrimehodVesting(
                token, msg.sender, vestAmount, releasePerPeriod, vestPeriod
            );
            vesting = address(v);
            allocated += vestAmount;
            require(t.transfer(vesting, vestAmount), "vest transfer failed");
        }

        uint256 curveSupply = TOTAL_SUPPLY - allocated;
        require(curveSupply > 0, "no curve supply");

        PrimehodCurve c = new PrimehodCurve(
            token,
            msg.sender,          // creator
            platform,
            curveSupply,
            initialVirtualEth,   // virtual ETH reserve
            curveSupply,         // virtual token reserve = curve supply
            baseFeeBps,
            dynamicMaxFeeBps,
            creatorSplitBps,
            graduationCap
        );
        curve = address(c);
        require(t.transfer(curve, curveSupply), "curve transfer failed");

        launchOf[token] = Launch({token: token, curve: curve, vesting: vesting, creator: msg.sender});
        metadataOf[token] = metadataURI;
        allTokens.push(token);

        emit TokenLaunched(token, msg.sender, curve, vesting, baseFeeBps);
    }

    function tokensCount() external view returns (uint256) {
        return allTokens.length;
    }
}
