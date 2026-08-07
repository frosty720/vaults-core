import { expect } from 'chai'
import { ethers } from 'hardhat'

describe('Mocks', () => {
	it('MockERC20 honours custom decimals', async () => {
		const ERC20 = await ethers.getContractFactory('MockERC20')
		const usdt = await ERC20.deploy('Tether', 'USDT', 6)
		expect(await usdt.decimals()).to.equal(6)
	})

	it('MockSwapRouter swaps tokenIn for tokenOut at the configured rate', async () => {
		const [user] = await ethers.getSigners()
		const ERC20 = await ethers.getContractFactory('MockERC20')
		const stable = await ERC20.deploy('DAI', 'DAI', 18)
		const wklc = await ERC20.deploy('WKLC', 'WKLC', 18)
		const Router = await ethers.getContractFactory('MockSwapRouter')
		const router = await Router.deploy()
		await router.setRate(stable.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		await stable.mint(user.address, ethers.parseEther('100'))
		await stable.approve(router.target, ethers.parseEther('100'))
		const out = await router.exactInputSingle.staticCall({
			tokenIn: stable.target, tokenOut: wklc.target, fee: 10000,
			recipient: user.address, amountIn: ethers.parseEther('100'),
			amountOutMinimum: ethers.parseEther('50000'), sqrtPriceLimitX96: 0,
		})
		expect(out).to.equal(ethers.parseEther('50000'))
	})

	it('MockSwapRouter reverts when output below amountOutMinimum', async () => {
		const [user] = await ethers.getSigners()
		const ERC20 = await ethers.getContractFactory('MockERC20')
		const stable = await ERC20.deploy('DAI', 'DAI', 18)
		const wklc = await ERC20.deploy('WKLC', 'WKLC', 18)
		const router = await (await ethers.getContractFactory('MockSwapRouter')).deploy()
		await router.setRate(stable.target, wklc.target, ethers.parseEther('500'))
		await wklc.mint(router.target, ethers.parseEther('1000000'))
		await stable.mint(user.address, ethers.parseEther('100'))
		await stable.approve(router.target, ethers.parseEther('100'))
		await expect(router.exactInputSingle({
			tokenIn: stable.target, tokenOut: wklc.target, fee: 10000,
			recipient: user.address, amountIn: ethers.parseEther('100'),
			amountOutMinimum: ethers.parseEther('99999999'), sqrtPriceLimitX96: 0,
		})).to.be.revertedWith('MockRouter: insufficient output')
	})
})
