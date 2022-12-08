import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { BigNumber, ContractFactory, Wallet } from 'ethers'
import hre, { ethers, waffle } from 'hardhat'
import { IMPLEMENTATION } from '../../fixtures'
import { defaultFixture, ORACLE_TIMEOUT } from './fixtures'
import { getChainId } from '../../../common/blockchain-utils'
import {
  IConfig,
  IGovParams,
  IRevenueShare,
  IRTokenConfig,
  IRTokenSetup,
  networkConfig,
} from '../../../common/configuration'
import { CollateralStatus, ZERO_ADDRESS } from '../../../common/constants'
import { expectInIndirectReceipt } from '../../../common/events'
import { bn, fp, toBNDecimals } from '../../../common/numbers'
import { whileImpersonating } from '../../utils/impersonation'
import { advanceBlocks, advanceTime, getLatestBlockNumber } from '../../utils/time'
import {
  Asset,
  ERC20Mock,
  FacadeRead,
  FacadeTest,
  FacadeWrite,
  IAssetRegistry,
  IBasketHandler,
  OracleLib,
  MockV3Aggregator,
  RTokenAsset,
  TestIBackingManager,
  TestIDeployer,
  TestIMain,
  TestIRToken,
  BancorV3FiatCollateral,
  IBnTokenERC20,
  IStandardRewards,
  IAutoCompoundingRewards,
  IBancorTradingProxy,
} from '../../../typechain'

const createFixtureLoader = waffle.createFixtureLoader

// Holder address in Mainnet
const HOLDER_BNDAI = '0xb494096548aa049c066289a083204e923cbf4413'

const describeFork = process.env.FORK ? describe : describe.skip

describeFork(`BancorV3FiatCollateral - Mainnet Forking P${IMPLEMENTATION}`, function () {
  let owner: SignerWithAddress
  let addr1: SignerWithAddress

  // Tokens/Assets
  let bnDAI: ERC20Mock
  let BancorV3Collateral: BancorV3FiatCollateral
  let bancorProxy: IBnTokenERC20
  let rewardsProxy: IStandardRewards
  let autoProcessRewardsProxy: IAutoCompoundingRewards
  let bancorTradingProxy: IBancorTradingProxy
  let bancorToken: ERC20Mock
  let bancorAsset: Asset
  let rsr: ERC20Mock
  let rsrAsset: Asset

  // Core Contracts
  let main: TestIMain
  let rToken: TestIRToken
  let rTokenAsset: RTokenAsset
  let assetRegistry: IAssetRegistry
  let backingManager: TestIBackingManager
  let basketHandler: IBasketHandler

  let deployer: TestIDeployer
  let facade: FacadeRead
  let facadeTest: FacadeTest
  let facadeWrite: FacadeWrite
  let oracleLib: OracleLib
  let govParams: IGovParams

  // RToken Configuration
  const dist: IRevenueShare = {
    rTokenDist: bn(40), // 2/5 RToken
    rsrDist: bn(60), // 3/5 RSR
  }
  const config: IConfig = {
    dist: dist,
    minTradeVolume: fp('1e4'), // $10k
    rTokenMaxTradeVolume: fp('1e6'), // $1M
    shortFreeze: bn('259200'), // 3 days
    longFreeze: bn('2592000'), // 30 days
    rewardPeriod: bn('604800'), // 1 week
    rewardRatio: fp('0.02284'), // approx. half life of 30 pay periods
    unstakingDelay: bn('1209600'), // 2 weeks
    tradingDelay: bn('0'), // (the delay _after_ default has been confirmed)
    auctionLength: bn('900'), // 15 minutes
    backingBuffer: fp('0.0001'), // 0.01%
    maxTradeSlippage: fp('0.01'), // 1%
    issuanceRate: fp('0.00025'), // 0.025% per block or ~0.1% per minute
    scalingRedemptionRate: fp('0.05'), // 5%
    redemptionRateFloor: fp('1e6'), // 1M RToken
  }

  const defaultThreshold = fp('0.05') // 5%
  const delayUntilDefault = bn('86400') // 24h

  let loadFixture: ReturnType<typeof createFixtureLoader>
  let wallet: Wallet

  let chainId: number

  let BancorV3CollateralFactory: ContractFactory
  let MockV3AggregatorFactory: ContractFactory
  let mockChainlinkFeed: MockV3Aggregator

  before(async () => {
    ;[wallet] = (await ethers.getSigners()) as unknown as Wallet[]
    loadFixture = createFixtureLoader([wallet])

    chainId = await getChainId(hre)
    if (!networkConfig[chainId]) {
      throw new Error(`Missing network configuration for ${hre.network.name}`)
    }
  })

  beforeEach(async () => {
    await console.log(await getLatestBlockNumber())
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: 'https://mainnet.infura.io/v3/384ad2c599cf430b9176c28bb6b484c1',
            blockNumber: await getLatestBlockNumber() + 1000,
          },
        },
      ],
    });
    console.log('block advanced')
    await console.log(await getLatestBlockNumber())
    
    ;[owner, addr1] = await ethers.getSigners()
    ;({ rsr, rsrAsset, deployer, facade, facadeTest, facadeWrite, oracleLib, govParams } =
      await loadFixture(defaultFixture))

    bnDAI = <ERC20Mock>(
      await ethers.getContractAt('ERC20Mock', networkConfig[chainId].tokens.bnDAI || '')
    )

    bancorProxy = <IBnTokenERC20>(
      await ethers.getContractAt('IBnTokenERC20', networkConfig[chainId].BANCOR_PROXY || '')
    )

    rewardsProxy = <IStandardRewards>(
      await ethers.getContractAt(
        'IStandardRewards',
        networkConfig[chainId].BANCOR_REWARDS_PROXY || ''
      )
    )

    bancorTradingProxy = <IBancorTradingProxy>(
      await ethers.getContractAt(
        'IBancorTradingProxy',
        networkConfig[chainId].BANCOR_TRADING_PROXY || ''
      )
    )

    autoProcessRewardsProxy = <IAutoCompoundingRewards>(
      await ethers.getContractAt(
        'IAutoCompoundingRewards',
        networkConfig[chainId].BANCOR_PROCESSING_PROXY || ''
      )
    )

    bancorToken = <ERC20Mock>(
      await ethers.getContractAt('ERC20Mock', networkConfig[chainId].tokens.BNT || '')
    )

    bancorAsset = <Asset>(
      await (
        await ethers.getContractFactory('Asset')
      ).deploy(
        fp('1'),
        networkConfig[chainId].chainlinkFeeds.BNT || '',
        bancorToken.address,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT
      )
    )

    // Deploy BancorV3 collateral plugin
    BancorV3CollateralFactory = await ethers.getContractFactory('BancorV3FiatCollateral', {
      libraries: { OracleLib: oracleLib.address },
    })
    BancorV3Collateral = <BancorV3FiatCollateral>(
      await BancorV3CollateralFactory.deploy(
        fp('0.02'),
        networkConfig[chainId].chainlinkFeeds.DAI as string,
        bnDAI.address,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT,
        ethers.utils.formatBytes32String('USD'),
        defaultThreshold,
        delayUntilDefault,
        bancorProxy.address,
        rewardsProxy.address,
        autoProcessRewardsProxy.address
      )
    )

    // Setup balances of bnDAI for addr1 - Transfer from Mainnet holder
    await whileImpersonating(HOLDER_BNDAI, async (bnDAISigner) => {
      await bnDAI.connect(bnDAISigner).transfer(addr1.address, bn('200000e8'))
    })

    // Set parameters
    const rTokenConfig: IRTokenConfig = {
      name: 'RTKN RToken',
      symbol: 'RTKN',
      mandate: 'mandate',
      params: config,
    }

    // Set primary basket
    const rTokenSetup: IRTokenSetup = {
      assets: [bancorAsset.address],
      primaryBasket: [BancorV3Collateral.address],
      weights: [fp('1')],
      backups: [],
      beneficiary: ZERO_ADDRESS,
      revShare: { rTokenDist: bn('0'), rsrDist: bn('0') },
    }

    // Deploy RToken via FacadeWrite
    const receipt = await (
      await facadeWrite.connect(owner).deployRToken(rTokenConfig, rTokenSetup)
    ).wait()

    // Get Main
    const mainAddr = expectInIndirectReceipt(receipt, deployer.interface, 'RTokenCreated').args.main
    main = <TestIMain>await ethers.getContractAt('TestIMain', mainAddr)

    // Get core contracts
    assetRegistry = <IAssetRegistry>(
      await ethers.getContractAt('IAssetRegistry', await main.assetRegistry())
    )
    backingManager = <TestIBackingManager>(
      await ethers.getContractAt('TestIBackingManager', await main.backingManager())
    )
    basketHandler = <IBasketHandler>(
      await ethers.getContractAt('IBasketHandler', await main.basketHandler())
    )
    rToken = <TestIRToken>await ethers.getContractAt('TestIRToken', await main.rToken())
    rTokenAsset = <RTokenAsset>(
      await ethers.getContractAt('RTokenAsset', await assetRegistry.toAsset(rToken.address))
    )

    // Setup owner and unpause
    await facadeWrite.connect(owner).setupGovernance(
      rToken.address,
      false, // do not deploy governance
      true, // unpaused
      govParams, // mock values, not relevant
      owner.address, // owner
      ZERO_ADDRESS, // no guardian
      ZERO_ADDRESS // no pauser
    )

    // Setup mock chainlink feed for some of the tests (so we can change the value)
    MockV3AggregatorFactory = await ethers.getContractFactory('MockV3Aggregator')
    mockChainlinkFeed = <MockV3Aggregator>await MockV3AggregatorFactory.deploy(8, bn('1e8'))
  })

  describe('Deployment', () => {
    it('Should setup RToken, Assets, and Collateral correctly', async () => {
      // COMP Asset
      expect(await bancorAsset.isCollateral()).to.equal(false)
      expect(await bancorAsset.erc20()).to.equal(bancorToken.address)
      expect(await bancorAsset.erc20()).to.equal(networkConfig[chainId].tokens.BNT)
      expect(await bancorToken.decimals()).to.equal(18)
      expect(await bancorAsset.strictPrice()).to.be.closeTo(fp('0.4'), fp('0.3')) // Close to $58 USD - June 2022
      await expect(bancorAsset.claimRewards()).to.not.emit(bancorAsset, 'RewardsClaimed')
      expect(await bancorAsset.maxTradeVolume()).to.equal(config.rTokenMaxTradeVolume)

      expect(await bancorProxy.address).to.equal(networkConfig[chainId].BANCOR_PROXY)
      expect(await BancorV3Collateral.isCollateral()).to.equal(true)
      expect(await BancorV3Collateral.erc20Decimals()).to.equal(await bnDAI.decimals())
      expect(await BancorV3Collateral.erc20()).to.equal(bnDAI.address)
      expect(await BancorV3Collateral.targetName()).to.equal(
        ethers.utils.formatBytes32String('USD')
      )
      expect(await BancorV3Collateral.targetPerRef()).to.equal(fp('1'))
      expect(await BancorV3Collateral.pricePerTarget()).to.equal(fp('1'))
      expect(await BancorV3Collateral.maxTradeVolume()).to.equal(config.rTokenMaxTradeVolume)
      expect(await BancorV3Collateral.refPerTok()).to.be.closeTo(fp('1.003759'), fp('0.5')) // close to $1
      expect(await BancorV3Collateral.strictPrice()).to.be.closeTo(fp('1'), fp('0.5')) // close to $0.022 cents

      await expect(BancorV3Collateral.claimRewards())
        .to.emit(BancorV3Collateral, 'RewardsClaimed')
        .withArgs(bancorToken.address, 0)

      // Should setup contracts
      expect(main.address).to.not.equal(ZERO_ADDRESS)
  
    })
    

    it('Should register ERC20s and Assets/Collateral correctly', async () => {
      // Check assets/collateral
      const ERC20s = await assetRegistry.erc20s()
      expect(ERC20s[0]).to.equal(rToken.address)
      expect(ERC20s[1]).to.equal(rsr.address)
      expect(ERC20s[2]).to.equal(bancorToken.address)
      expect(ERC20s[3]).to.equal(bnDAI.address)
      expect(ERC20s.length).to.eql(4)

      // Assets
      expect(await assetRegistry.toAsset(ERC20s[0])).to.equal(rTokenAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[1])).to.equal(rsrAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[2])).to.equal(bancorAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[3])).to.equal(BancorV3Collateral.address)

      // Collaterals
      expect(await assetRegistry.toColl(ERC20s[3])).to.equal(BancorV3Collateral.address)
    })

    // Check RToken basket
    it('Should register Basket correctly', async () => {
      // Basket
      expect(await basketHandler.fullyCollateralized()).to.equal(true)
      const backing = await facade.basketTokens(rToken.address)
      expect(backing[0]).to.equal(bnDAI.address)
      expect(backing.length).to.equal(1)

      // Check other values
      expect(await basketHandler.nonce()).to.be.gt(bn(0))
      expect(await basketHandler.timestamp()).to.be.gt(bn(0))
      expect(await basketHandler.status()).to.equal(CollateralStatus.SOUND)
      expect(await facadeTest.callStatic.totalAssetValue(rToken.address)).to.equal(0)
      const [isFallback, price] = await basketHandler.price(true)
      expect(isFallback).to.equal(false)
      expect(price).to.be.closeTo(fp('1'), fp('0.015'))

      // Check RToken price
      const issueAmount: BigNumber = bn('2000e8')
      await bnDAI.connect(addr1).approve(rToken.address, issueAmount)
      await expect(rToken.connect(addr1).issue(issueAmount)).to.emit(rToken, 'Issuance')
      expect(await rTokenAsset.strictPrice()).to.be.closeTo(fp('1'), fp('0.015'))
    })

    // Validate constructor arguments
    // Note: Adapt it to your plugin constructor validations
    it('Should validate constructor arguments correctly', async () => {
      // Default threshold
      await expect(
        BancorV3CollateralFactory.deploy(
          fp('0.02'),
          networkConfig[chainId].chainlinkFeeds.DAI as string,
          bnDAI.address,
          config.rTokenMaxTradeVolume,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          bn(0),
          delayUntilDefault,
          bancorProxy.address,
          rewardsProxy.address,
          autoProcessRewardsProxy.address
        )
      ).to.be.revertedWith('defaultThreshold zero')

      // Comptroller
      await expect(
        BancorV3CollateralFactory.deploy(
          fp('0.02'),
          networkConfig[chainId].chainlinkFeeds.DAI as string,
          bnDAI.address,
          config.rTokenMaxTradeVolume,
          ORACLE_TIMEOUT,
          ethers.utils.formatBytes32String('USD'),
          defaultThreshold,
          delayUntilDefault,
          bancorProxy.address,
          ZERO_ADDRESS,
          autoProcessRewardsProxy.address
        )
      ).to.be.revertedWith('standardRewards missing')

      
      
    })
  })

  

  describe('Issuance/Appreciation/Redemption', () => {
    const MIN_ISSUANCE_PER_BLOCK = bn('2000e8')
    
    // Issuance and redemption, making the collateral appreciate over time
    it('Should issue, redeem, and handle appreciation rates correctly', async () => {
      const issueAmount: BigNumber = MIN_ISSUANCE_PER_BLOCK // instant issuance

      // Provide approvals for issuances
      await bnDAI.connect(addr1).approve(rToken.address,issueAmount)

      // Issue rTokens
      await expect(rToken.connect(addr1).issue(issueAmount)).to.emit(rToken, 'Issuance')

      // Check RTokens issued to user
      expect(await rToken.balanceOf(addr1.address)).to.equal(issueAmount)

      // Store Balances after issuance
      const balanceAddr1bnDAI: BigNumber = await bnDAI.balanceOf(addr1.address)

      // Check rates and prices
      const bnDAIPrice1: BigNumber = await BancorV3Collateral.strictPrice() // ~ 0.022015 cents
      const bnDAIRefPerTok1: BigNumber = await BancorV3Collateral.refPerTok() // ~ 0.022015 cents

      expect(bnDAIPrice1).to.be.closeTo(fp('1'), fp('0.5'))
      expect(bnDAIRefPerTok1).to.be.closeTo(fp('1'), fp('0.5'))

      // Check total asset value
      const totalAssetValue1: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue1).to.be.closeTo(issueAmount, fp('150')) // approx 10K in value

      // await bnDAI.connect(addr1).approve(bancorTradingProxy.address,100000000000)
      // await bnDAI.allowance(addr1.address,bancorTradingProxy.address)
      // await console.log(await bnDAI.allowance(addr1.address,bancorTradingProxy.address))
      // await bancorTradingProxy.tradeBySourceAmount(bnDAI.address,bancorToken.address,100000000000,1,await getLatestBlockNumber() + 10000,addr1.address)
      
      // Advance time and blocks slightly, causing refPerTok() to increase

      // Refresh cToken manually (required)
      await BancorV3Collateral.refresh()
      expect(await BancorV3Collateral.status()).to.equal(CollateralStatus.SOUND)
      
      // Check rates and prices - Have changed, slight inrease
      const bnDAIPrice2: BigNumber = await BancorV3Collateral.strictPrice() // ~0.022016
      const bnDAIRefPerTok2: BigNumber = await BancorV3Collateral.refPerTok() // ~0.022016

      // Check rates and price increase
      //expect(bnDAIPrice2).to.be.gt(bnDAIPrice1)
      expect(bnDAIRefPerTok2).to.be.gt(bnDAIRefPerTok1)

      // Still close to the original values
      expect(bnDAIPrice2).to.be.closeTo(fp('1'), fp('0.5'))
      expect(bnDAIRefPerTok2).to.be.closeTo(fp('1'), fp('0.5'))

      // Check total asset value increased
      const totalAssetValue2: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue2).to.be.gte(totalAssetValue1)

      // Advance time and blocks slightly, causing refPerTok() to increase
      await advanceTime(100000)
      await advanceBlocks(100000)

      // Refresh cToken manually (required)
      await BancorV3Collateral.refresh()
      expect(await BancorV3Collateral.status()).to.equal(CollateralStatus.SOUND)

      // Check rates and prices - Have changed significantly
      const bnDAIPrice3: BigNumber = await BancorV3Collateral.strictPrice() // ~0.03294
      const bnDAIRefPerTok3: BigNumber = await BancorV3Collateral.refPerTok() // ~0.03294

      // Check rates and price increase
      expect(bnDAIPrice3).to.be.gt(bnDAIPrice2)
      expect(bnDAIRefPerTok3).to.be.gt(bnDAIRefPerTok2)

      // Need to adjust ranges
      expect(bnDAIPrice3).to.be.closeTo(fp('1'), fp('0.5'))
      expect(bnDAIRefPerTok3).to.be.closeTo(fp('1'), fp('0.5'))

      // Check total asset value increased
      const totalAssetValue3: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue3).to.be.gt(totalAssetValue2)

      // Redeem Rtokens with the updated rates
      await expect(rToken.connect(addr1).redeem(issueAmount)).to.emit(rToken, 'Redemption')

      // Check funds were transferred
      expect(await rToken.balanceOf(addr1.address)).to.equal(0)
      expect(await rToken.totalSupply()).to.equal(0)

      // Check balances - Fewer cTokens should have been sent to the user
      const newBalanceAddr1bnDAI: BigNumber = await bnDAI.balanceOf(addr1.address)

      // Check received tokens represent ~10K in value at current prices
      expect(newBalanceAddr1bnDAI.sub(balanceAddr1bnDAI)).to.be.closeTo(bn('303570e8'), bn('8e7')) // ~0.03294 * 303571 ~= 10K (100% of basket)

      // Check remainders in Backing Manager
      expect(await bnDAI.balanceOf(backingManager.address)).to.be.closeTo(bn(150663e8), bn('5e7')) // ~= 4962.8 usd in value

      //  Check total asset value (remainder)
      expect(await facadeTest.callStatic.totalAssetValue(rToken.address)).to.be.closeTo(
        fp('4962.8'), // ~= 4962.8 usd (from above)
        fp('0.5')
      )
    })
  })
})
