module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/generated/**",
    "!src/__tests__/**",
    "!src/index.ts",
    "!src/mqtt.ts",
    "!src/version.ts",
  ],
  coveragePathIgnorePatterns: ["/src/__tests__/helpers/"],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
};
