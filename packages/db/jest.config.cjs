module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@hipponot/soa-config$': '<rootDir>/../config/src/index.ts',
    '^@hipponot/soa-config/(.*)$': '<rootDir>/../config/src/$1.ts',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!@hipponot/soa-config)',
  ],
  testMatch: [
    '<rootDir>/src/**/*.test.ts'
  ],
}; 