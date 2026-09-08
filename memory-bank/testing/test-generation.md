# Comprehensive Test Generation

**Use this when:** You need to create thorough tests for your code, whether unit, integration, or end-to-end tests.

**Skill Level:** Beginner to Advanced

---

## Copy This Prompt:

```
I need help generating comprehensive tests for my code. Please create a thorough test suite that covers various scenarios and edge cases.

## Code to Test:
[PASTE YOUR CODE HERE OR DESCRIBE THE FUNCTIONALITY]

## Testing Requirements:
- **Test Types Needed**: [Unit tests / Integration tests / E2E tests / All of the above]
- **Testing Framework**: [Jest, Vitest, Pytest, JUnit, etc. - or ask for recommendation]
- **Coverage Goals**: [What percentage of code coverage are you aiming for?]
- **Specific Concerns**: [Any particular edge cases or scenarios you're worried about?]

## Test Generation Request:

Please create:

### 1. Test Strategy Overview
- Explain the overall testing approach
- Identify what needs to be tested at each level
- Recommend test structure and organisation

### 2. Unit Tests
Generate unit tests that cover:
- **Happy path scenarios** - normal, expected usage
- **Edge cases** - boundary conditions, empty inputs, null values
- **Error conditions** - invalid inputs, network failures, etc.
- **State changes** - before/after conditions for stateful code
- **Integration points** - mocked dependencies and their interactions

### 3. Test Data & Fixtures
Create:
- **Test data sets** for various scenarios
- **Mock objects** for external dependencies
- **Test fixtures** for setup and teardown
- **Factory functions** for generating test data

### 4. Assertions & Expectations
For each test, include:
- **Clear test descriptions** that explain what's being tested
- **Proper assertions** that validate expected behavior
- **Error message validation** for error cases
- **Performance assertions** if relevant

### 5. Advanced Testing Scenarios
Consider:
- **Concurrency testing** - race conditions, async behavior
- **Security testing** - input validation, injection attacks
- **Performance testing** - load, stress, memory usage
- **Compatibility testing** - different environments, browsers, devices

### 6. Test Maintenance
Provide:
- **Test organisation** - how to structure test files
- **Naming conventions** for tests and test data
- **Documentation** for complex test scenarios
- **CI/CD integration** recommendations

## Test Code Format:
Please provide:
- Complete, runnable test code
- Clear comments explaining complex test logic
- Setup and teardown code where needed
- Instructions for running the tests

## Additional Considerations:
- Suggest tools for test coverage reporting
- Recommend approaches for testing difficult-to-test code
- Provide guidelines for maintaining tests as code evolves
- Suggest performance benchmarks if applicable

Focus on creating tests that are reliable, maintainable, and provide confidence in the code's correctness.
```

---

## Tips for Better Results:

- **Include complete code context** - not just individual functions
- **Specify your testing environment** and any constraints
- **Mention existing tests** so AI doesn't duplicate efforts
- **Be clear about testing philosophy** - strict TDD vs pragmatic testing
- **Include domain knowledge** that affects what should be tested
