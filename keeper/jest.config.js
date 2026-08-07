/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/src'],
	testMatch: ['**/*.test.ts'],
	moduleFileExtensions: ['ts', 'js', 'json'],
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/**/*.d.ts',
		'!src/index.ts',
		'!src/services/ContractService.ts',
		'!src/utils/logger.ts',
	],
	coverageThreshold: {
		global: { statements: 90, branches: 85, functions: 90, lines: 90 },
	},
	coverageDirectory: 'coverage',
	verbose: true,
}
