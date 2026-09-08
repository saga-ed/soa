# Testing Phase Prompts

This folder contains prompts for comprehensive testing strategies - from unit tests to end-to-end testing and performance validation. These prompts help you create robust testing suites that ensure your application works correctly under all conditions.

## Available Prompts

### Core Testing

- **[Test Generation](./test-generation.md)** - Create comprehensive unit, integration, and e2e tests
- **[Integration Testing](./integration-testing.md)** - Test how different system components work together
- **[E2E Testing Strategy](./e2e-testing.md)** - End-to-end testing for complete user workflows

### Performance Testing

- **[Performance Testing](./performance-testing.md)** - Load testing, stress testing, and benchmarking

## When to Use Testing Prompts

### Starting Test Development

- **Test Generation** when you need to create tests for new or existing code
- **Integration Testing** when you need to test API endpoints, database operations, or external services
- **E2E Testing Strategy** when you want to test complete user journeys

### Performance Validation

- **Performance Testing** when you need to validate your application under load
- Use this for capacity planning, finding bottlenecks, and ensuring SLA compliance

## Testing Workflow

A comprehensive testing approach using these prompts:

1. **Unit Tests** → Use Test Generation for individual functions and components
2. **Integration Tests** → Use Integration Testing for system component interactions
3. **E2E Tests** → Use E2E Testing Strategy for complete user workflows
4. **Performance Tests** → Use Performance Testing for load and stress validation

## Pro Tips for Testing

### Test Generation

- Start with critical business logic and user-facing features
- Include both happy path and error scenarios
- Consider edge cases and boundary conditions

### Integration Testing

- Test real integrations where possible, use mocks sparingly
- Focus on data flow between components
- Include failure scenarios and recovery testing

### E2E Testing

- Focus on critical user journeys that generate business value
- Keep tests maintainable and not too brittle
- Include cross-browser and device testing

### Performance Testing

- Establish baseline performance metrics before testing
- Test with realistic data volumes and user patterns
- Include both normal load and stress scenarios

## Integration with Other Phases

- **From Development**: Use tests to validate code created with Development Phase prompts
- **From Planning**: Use requirements from Planning Phase to guide test scenarios
- **To Deployment**: Integrate tests into CI/CD using Deployment Phase prompts

## Testing Strategy Quick Reference

| I want to...                               | Use this prompt      |
| ------------------------------------------ | -------------------- |
| Create unit tests for my functions         | Test Generation      |
| Test API endpoints and database operations | Integration Testing  |
| Test complete user workflows               | E2E Testing Strategy |
| Validate performance under load            | Performance Testing  |

## Next Steps

After creating your tests:

- Use Documentation Phase prompts to document your testing approach
- Use Deployment Phase prompts to integrate tests into your CI/CD pipeline
- Use Maintenance Phase prompts for ongoing test maintenance
