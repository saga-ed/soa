# saga-soa: Multi-Technology Service-Oriented Architecture Platform

## Overview

**saga-soa** is a modern, modular monorepo that provides a unified foundation for building service-oriented architectures across multiple API technologies. It enables teams to develop, test, and deploy APIs using their preferred technology stack while sharing common infrastructure and patterns.

## 🏗️ Core Architecture

### Shared Infrastructure (`@hipponot/api-core`)

The platform's backbone is the `api-core` package, which provides:

- **Express Server Management**: Centralized server lifecycle, middleware, and configuration
- **Dependency Injection**: Inversify-based DI container for service management
- **Sector Loading**: Dynamic discovery and registration of API sectors/controllers
- **Cross-Technology Abstractions**: Unified patterns for REST, GraphQL, and tRPC

### Multi-Technology Support

**saga-soa** supports three major API technologies with consistent patterns:

#### 🔗 **REST APIs**

- `AbstractRestController` for standardized REST controllers
- Automatic route registration and middleware management
- Built-in validation and error handling

#### 🎯 **GraphQL APIs**

- `AbstractGQLController` for GraphQL resolvers
- Apollo Server integration with sector-based schema composition
- Type-safe resolver development with TypeGraphQL

#### ⚡ **tRPC APIs**

- `AbstractTRPCController` for tRPC routers
- `TRPCAppRouter` for centralized router management
- Namespaced procedure organization and automatic middleware generation

## 🔄 Dynamic Sector Loading

### Sector Pattern

All API technologies follow a consistent sector pattern:

```
sectors/
├── user/
│   ├── rest/     # REST controllers
│   ├── gql/      # GraphQL resolvers
│   └── trpc/     # tRPC routers
├── project/
│   ├── rest/
│   ├── gql/
│   └── trpc/
└── session/
    ├── rest/
    ├── gql/
    └── trpc/
```

### Automatic Discovery

- **Dynamic Loading**: Sectors are automatically discovered and registered via DI
- **Technology Agnostic**: Same business logic can be exposed via multiple APIs
- **Hot Reloading**: Sectors can be added/removed without server restart
- **Dependency Management**: Automatic injection of shared services (logger, db, config)

## 🛠️ Shared Services

### Configuration (`@hipponot/config`)

- Zod-based schema validation
- Environment-specific configuration
- Type-safe configuration management

### Database (`@hipponot/db`)

- MongoDB, SQL, Redis support
- Connection pooling and management
- Mock providers for testing

### Logging (`@hipponot/logger`)

- Structured logging with Pino
- Request/response correlation
- Performance monitoring

## 🚀 Example Implementations

### REST API Example

```typescript
@injectable()
export class UserController extends AbstractRestController {
  @Get('/users')
  async getUsers() {
    /* ... */
  }

  @Post('/users')
  async createUser() {
    /* ... */
  }
}
```

### GraphQL API Example

```typescript
@injectable()
export class UserResolver extends AbstractGQLController {
  @Query()
  async users() {
    /* ... */
  }

  @Mutation()
  async createUser() {
    /* ... */
  }
}
```

### tRPC API Example

```typescript
@injectable()
export class UserController extends AbstractTRPCController {
  createRouter() {
    return router({
      getAllUsers: t.query(() => {
        /* ... */
      }),
      createUser: t.mutation(() => {
        /* ... */
      }),
    });
  }
}
```

## 🎯 Key Benefits

### **Technology Flexibility**

- Choose the right API technology for each use case
- Migrate between technologies without rewriting business logic
- Support multiple client types (web, mobile, third-party)

### **Developer Experience**

- Consistent patterns across all API technologies
- Shared tooling and infrastructure
- Type safety from database to client

### **Operational Excellence**

- Centralized monitoring and logging
- Unified deployment patterns
- Shared security and validation

### **Scalability**

- Modular sector-based architecture
- Independent scaling of different API types
- Shared resource optimization

## 🔧 Development Workflow

1. **Define Sectors**: Create business logic in sector modules
2. **Choose Technology**: Implement REST, GraphQL, or tRPC interfaces
3. **Register Services**: Add to DI container for automatic discovery
4. **Deploy**: Single deployment pipeline for all API types

## 📊 Current Status

- ✅ **REST APIs**: Fully implemented with sector loading
- ✅ **GraphQL APIs**: Apollo Server integration with TypeGraphQL
- ✅ **tRPC APIs**: Complete router management with namespacing
- ✅ **Shared Infrastructure**: Core services and DI patterns
- ✅ **Testing**: Comprehensive test coverage across all technologies
- ✅ **Documentation**: Examples and guides for all patterns

**saga-soa** provides a production-ready foundation for building modern, scalable APIs with the flexibility to choose the right technology for each use case while maintaining consistency and developer productivity.
