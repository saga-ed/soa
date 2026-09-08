# Integration Testing Assistant

**Use this when:** You need to test how different parts of your system work together, including APIs, databases, and external services.

**Skill Level:** Intermediate to Advanced

---

## Copy This Prompt:

```
I need help creating comprehensive integration tests for my application. Please help me design and implement tests that verify how different components work together.

## System Context:
- **Application Architecture**: [Microservices, monolith, serverless, etc.]
- **Technology Stack**: [Languages, frameworks, databases, etc.]
- **External Dependencies**: [APIs, databases, message queues, etc.]
- **Testing Framework**: [Jest, Pytest, JUnit, etc. - or ask for recommendation]

## Integration Points to Test:
[Describe the key integration points - API endpoints, database operations, external service calls, etc.]

## Current Testing Setup:
[Describe any existing testing infrastructure and what you've already tested]

## Integration Testing Strategy:

Please create a comprehensive integration testing approach that covers:

### 1. Testing Strategy Overview
- Integration testing levels and scope
- Test environment setup and requirements
- Data management strategy for tests
- CI/CD integration approach

### 2. API Integration Testing
- **Endpoint Testing**: Full request/response cycle testing
- **Authentication Testing**: Token validation, session management
- **Data Validation**: Request/response schema validation
- **Error Handling**: Error responses, timeout handling
- **Rate Limiting**: API throttling and quota testing

### 3. Database Integration Testing
- **CRUD Operations**: Create, read, update, delete testing
- **Transaction Testing**: Database transaction integrity
- **Migration Testing**: Schema changes and data migration
- **Performance Testing**: Query performance and optimization
- **Constraint Testing**: Foreign keys, unique constraints, validations

### 4. External Service Integration
- **API Client Testing**: Third-party API integration
- **Mock vs Real Services**: When to use mocks vs real services
- **Failure Scenarios**: Network failures, service downtime
- **Authentication Flow**: OAuth, API key validation
- **Data Synchronization**: Data consistency across services

### 5. Message Queue/Event Testing
- **Message Publishing**: Event publishing and routing
- **Message Consumption**: Event processing and handling
- **Dead Letter Queues**: Failed message handling
- **Ordering and Delivery**: Message ordering guarantees
- **Event Sourcing**: Event store integration (if applicable)

### 6. File System Integration
- **File Upload/Download**: File handling operations
- **Storage Integration**: Cloud storage (S3, GCS, etc.)
- **File Processing**: Image processing, document handling
- **Backup and Recovery**: Data backup procedures

### 7. Test Data Management
- **Test Data Setup**: Creating realistic test datasets
- **Data Cleanup**: Teardown and cleanup procedures
- **Data Isolation**: Preventing test interference
- **Seed Data**: Consistent test data across environments
- **Data Factories**: Generating test data programmatically

### 8. Environment Configuration
- **Test Environment Setup**: Isolated testing environments
- **Configuration Management**: Environment-specific settings
- **Secret Management**: API keys, credentials in tests
- **Container Testing**: Docker/Kubernetes integration
- **Local Development**: Running integration tests locally

### 9. Test Implementation Examples
For each integration point, provide:
- **Complete test code** with setup and teardown
- **Assertion examples** for success and failure cases
- **Mock configurations** for external dependencies
- **Error handling tests** for network failures
- **Performance assertions** where relevant

### 10. Advanced Testing Scenarios
- **Contract Testing**: API contract validation
- **End-to-End Workflows**: Multi-step business processes
- **Concurrency Testing**: Race conditions, parallel execution
- **Security Testing**: Authorization, input validation
- **Chaos Testing**: Resilience and fault tolerance

## Test Organization Structure:
- Recommend test file organization
- Naming conventions for integration tests
- Grouping related tests effectively
- Parallel test execution strategies

## CI/CD Integration:
- Integration test pipeline setup
- When to run integration tests
- Handling test failures and retries
- Test reporting and notifications

## Monitoring and Maintenance:
- Test result analysis and reporting
- Identifying flaky tests
- Test performance monitoring
- Updating tests with system changes

Please provide specific, runnable test code examples that I can implement immediately.
```

---

## Tips for Better Results:

- **Map out all integration points** - APIs, databases, external services
- **Include your current test setup** - what framework and tools you're using
- **Specify environment constraints** - local vs cloud, CI/CD requirements
- **Mention data sensitivity** - PII, test data isolation needs
- **Include performance requirements** - test execution time, parallel execution
