### Introduction

Inversify is a "A powerful and lightweight inversion of control container for JavaScript & Node.js apps powered by
TypeScript"

#### Inversify Basics

https://inversify.io/introduction/getting-started

#### saga-soa usage

The saga-soa project is the root project of a turborepo managed monorepo. There will be many submodules written in typescipt that implement both library and application functionality. I want to ensure inversfiy.io is used across these submodules to manage the instantiation of exports from each submodule in the importing module as well as internally within the submodule.

#### Requirements

1. **Interface-Based Design**

   - All concrete implementations must be abstracted behind interfaces
   - Services should be defined using TypeScript interfaces
   - Dependencies should be injected through constructor parameters
   - Interfaces MUST be in separate files from implementations
   - Each interface file should export ONLY the interface and its related types
   - Package exports MUST be configured to allow importing interfaces separately
   - Example package.json configuration:
     ```json
     {
       "exports": {
         ".": {
           "types": "./dist/index.d.ts",
           "default": "./dist/index.js"
         },
         "./i-service-name": {
           "types": "./dist/i-service-name.d.ts",
           "default": "./dist/i-service-name.js"
         }
       }
     }
     ```

2. **Metadata-Based Binding**

   - Utilize TypeScript's emitted decorator metadata to automatically bind implementations to interfaces
   - Avoid manual creation of service identifiers where possible
   - Use `@injectable()` decorator on concrete implementations
   - Use `@inject()` decorator for constructor parameter injection

3. **Container Configuration**

   - Each submodule should export its own container configuration
   - Container configurations should be composable across the monorepo
   - Use `container.bind<Interface>().to(Implementation)` pattern
   - Leverage TypeScript's type system to ensure type safety

4. **File Structure**

   ```
   src/
   ├── interfaces/
   │   └── i-service-name.ts       # Interface and related types only
   ├── implementations/
   │   └── service-name.ts         # Concrete implementation
   ├── index.ts                    # Main exports
   └── __tests__/
       ├── service-name.test.ts    # Implementation tests
       └── mock-service-name.ts    # Mock implementation for testing
   ```

5. **Example Implementation**

   ```typescript
   // interfaces/i-user-service.ts
   export interface IUserService {
     getUser(id: string): Promise<User>;
   }

   // implementations/user-service.ts
   import { IUserService } from '../interfaces/i-user-service';

   @injectable()
   export class UserService implements IUserService {
     constructor(@inject('IUserRepository') private userRepository: IUserRepository) {}

     async getUser(id: string): Promise<User> {
       return this.userRepository.findById(id);
     }
   }

   // Container configuration
   const container = new Container();
   container.bind<IUserService>('IUserService').to(UserService);
   ```

6. **Best Practices**
   - Keep interfaces in separate files from implementations
   - Use meaningful interface names prefixed with 'I'
   - Document interfaces with JSDoc comments
   - Use dependency injection for all external dependencies
   - Avoid circular dependencies between modules
   - Place mock implementations in **tests** directory
   - Configure package exports to support interface-only imports
   - Use type-only exports for interfaces in index.ts:
     ```typescript
     export type { IServiceName } from './interfaces/i-service-name';
     export { ServiceName } from './implementations/service-name';
     ```
