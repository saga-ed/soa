module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@hipponot/config$': '<rootDir>/../config/src/index.ts',
    '^@hipponot/config/(.*)$': '<rootDir>/../config/src/$1.ts',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!@hipponot/config)',
  ],
  testMatch: [
    '<rootDir>/src/**/*.test.ts'
  ],
}; 