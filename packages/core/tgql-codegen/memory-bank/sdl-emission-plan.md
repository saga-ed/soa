# tgql-codegen SDL Emission and GraphQL CodeGen Integration

## Overview

This document outlines the implementation of SDL (Schema Definition Language) emission capabilities in the tgql-codegen tool, leveraging the `buildSchema` functionality from the type-graphql package, and the integration with graphql-codegen for proper client-side type generation.

## Current State

- ✅ tgql-codegen now generates GraphQL SDL files from TypeGraphQL resolvers
- ✅ SDL emission is integrated with graphql-codegen for proper client-side type generation
- ✅ The tool supports a two-phase generation workflow:
  1. **Phase 1**: Emit SDL files from TypeGraphQL resolvers
  2. **Phase 2**: Generate TypeScript types from SDL using graphql-codegen
- ✅ Ad-hoc type generation has been removed and replaced with proper graphql-codegen integration

## Implementation Status

### ✅ Phase 1: SDL Emission (Completed)

**Objective**: Generate GraphQL SDL files from TypeGraphQL resolvers.

**Implementation**:
- ✅ **SDL Generator Class**: `SDLGenerator` class handles SDL emission
- ✅ **Sector-based Emission**: Supports emitting separate SDL files for each sector
- ✅ **Unified Schema**: Supports emitting single unified schema file
- ✅ **Configuration**: Full configuration support for SDL emission options

**Key Features**:
- Dynamic resolver class loading
- Sector-based SDL emission with `emitSectorSDL` method
- Unified schema emission with `emitSDL` method
- File system operations with proper error handling

### ✅ Phase 2: GraphQL CodeGen Integration (Completed)

**Objective**: Replace ad-hoc type generation with proper graphql-codegen integration.

**Implementation**:
- ✅ **GraphQL CodeGen Generator**: `GraphQLCodeGenGenerator` class handles type generation
- ✅ **Configuration Integration**: Added `graphqlCodegen` configuration section
- ✅ **CLI Integration**: Updated CLI to support both phases independently
- ✅ **Dependencies**: Added graphql-codegen dependencies to package.json

**Key Features**:
- Uses graphql-codegen for proper client-side type generation
- Supports all graphql-codegen plugins (typescript, typescript-operations, etc.)
- Configurable schema paths and output directories
- Proper error handling and logging

### ✅ Phase 3: CLI Updates (Completed)

**Objective**: Update CLI to support the new two-phase workflow.

**Implementation**:
- ✅ **New Commands**: Added `emit-types` command for type generation only
- ✅ **Enhanced Generate**: Updated `generate` command to support both phases
- ✅ **Independent Phases**: Support for running phases independently
- ✅ **Configuration Overrides**: CLI options to override configuration

**Available Commands**:
```bash
# Generate both SDL and types
tgql-codegen generate

# Generate only SDL files
tgql-codegen emit-sdl
tgql-codegen generate --sdl-only

# Generate only types from SDL
tgql-codegen emit-types
tgql-codegen generate --types-only

# Watch mode
tgql-codegen watch
```

### ✅ Phase 4: Configuration Updates (Completed)

**Objective**: Add comprehensive configuration support for both phases.

**Implementation**:
- ✅ **SDL Configuration**: Full configuration for SDL emission options
- ✅ **GraphQL CodeGen Configuration**: Configuration for graphql-codegen integration
- ✅ **Default Configuration**: Sensible defaults for both phases
- ✅ **CLI Overrides**: Support for overriding configuration via CLI options

**Configuration Structure**:
```typescript
interface TGQLCodegenConfig {
  // ... existing config
  sdl: {
    enabled: boolean;
    outputDir: string;
    fileName?: string;
    emitBySector: boolean;
    sectorFileNamePattern?: string;
  };
  graphqlCodegen: {
    enabled: boolean;
    schemaPath: string;
    documents?: string;
    outputDir: string;
    plugins: string[];
    config?: Record<string, any>;
  };
}
```

### ✅ Phase 5: Documentation (Completed)

**Objective**: Document the new workflow and provide usage examples.

**Implementation**:
- ✅ **Comprehensive README**: Updated README with new workflow documentation
- ✅ **CLI Documentation**: Documented all available commands and options
- ✅ **Configuration Examples**: Provided configuration examples for different use cases
- ✅ **Migration Guide**: Documented migration from ad-hoc generation
- ✅ **Troubleshooting**: Added troubleshooting section for common issues

## Key Technical Decisions

### 1. Two-Phase Architecture

**Decision**: Implement a two-phase generation workflow instead of direct type generation.

**Rationale**:
- SDL emission provides a clear intermediate representation
- Enables use of industry-standard graphql-codegen tools
- Supports multiple client types (Apollo, URQL, etc.)
- Provides better separation of concerns

**Implementation**:
```typescript
// Phase 1: SDL Emission
await this.generateSDL(sectors);

// Phase 2: Type Generation
await this.graphqlCodegenGenerator.generateTypes();
```

### 2. GraphQL CodeGen Integration

**Decision**: Use graphql-codegen instead of custom type generation.

**Rationale**:
- Industry standard for GraphQL type generation
- Supports all GraphQL features and edge cases
- Better client-side integration
- More accurate type definitions
- Extensive plugin ecosystem

**Implementation**:
```typescript
export class GraphQLCodeGenGenerator {
  async generateTypes(): Promise<void> {
    // Create graphql-codegen configuration
    const codegenConfig = this.createCodegenConfig();
    
    // Run graphql-codegen
    await this.runCodegen(configPath);
  }
}
```

### 3. CLI Command Structure

**Decision**: Support both combined and independent phase execution.

**Rationale**:
- Allows developers to run phases independently
- Supports different workflows (SDL-only, types-only, both)
- Enables integration with different build tools
- Provides flexibility for different use cases

**Implementation**:
```bash
# Combined workflow
tgql-codegen generate

# Independent phases
tgql-codegen emit-sdl
tgql-codegen emit-types
```

## Configuration Examples

### Basic Configuration

```javascript
module.exports = {
  sdl: {
    enabled: true,
    outputDir: './generated/schema',
    emitBySector: true
  },
  graphqlCodegen: {
    enabled: true,
    schemaPath: './generated/schema/*.graphql',
    outputDir: './generated/types',
    plugins: ['typescript', 'typescript-operations']
  }
};
```

### Advanced Configuration

```javascript
module.exports = {
  sdl: {
    enabled: true,
    outputDir: './generated/schema',
    emitBySector: true,
    sectorFileNamePattern: '{sector}.graphql'
  },
  graphqlCodegen: {
    enabled: true,
    schemaPath: './generated/schema/*.graphql',
    outputDir: './generated/types',
    plugins: ['typescript', 'typescript-operations', 'typescript-react-apollo'],
    config: {
      scalars: {
        ID: 'string',
        DateTime: 'Date'
      },
      avoidOptionals: {
        field: true,
        inputValue: false,
        object: false
      }
    }
  }
};
```

## Migration from Ad-Hoc Generation

### Before (Removed)
```typescript
// Old ad-hoc type generation
export class SchemaGenerator {
  async generateSchema(sectors: SectorInfo[]): Promise<GenerationResult> {
    // Manual type mapping and generation
    const typeContent = this.generateSectorTypes(sector);
    // ...
  }
}
```

### After (GraphQL CodeGen)
```typescript
// New graphql-codegen integration
export class GraphQLCodeGenGenerator {
  async generateTypes(): Promise<void> {
    // Use graphql-codegen for proper type generation
    await this.runCodegen(configPath);
  }
}
```

## Benefits of the New Approach

### ✅ Proper GraphQL Type Generation
- Uses graphql-codegen for accurate type generation
- Supports all GraphQL features (unions, interfaces, etc.)
- Handles complex type scenarios correctly

### ✅ Client-Side Integration
- Supports multiple GraphQL clients (Apollo, URQL, etc.)
- Generates operation types for queries and mutations
- Provides better developer experience

### ✅ Industry Standard
- Uses established graphql-codegen ecosystem
- Leverages community-maintained plugins
- Follows GraphQL best practices

### ✅ Flexibility
- Supports both sector-based and unified SDL emission
- Configurable for different use cases
- Independent phase execution

### ✅ Maintainability
- Clear separation of concerns
- Better error handling and logging
- Comprehensive documentation

## Future Enhancements

### Potential Improvements

1. **Federation Support**: Add support for Apollo Federation v2
2. **Plugin Ecosystem**: Support for more graphql-codegen plugins
3. **Performance**: Optimize for large schema generation
4. **Validation**: Add schema validation before type generation
5. **Testing**: Add comprehensive test coverage

### Integration Opportunities

1. **Build Tools**: Better integration with Turbo, Webpack, etc.
2. **IDE Support**: GraphQLSP integration for better IDE experience
3. **CI/CD**: Automated type generation in CI/CD pipelines
4. **Monitoring**: Schema change detection and alerts

## Conclusion

The tgql-codegen tool now provides a robust, two-phase generation workflow that:

1. **Emits SDL files** from TypeGraphQL resolvers using industry-standard tools
2. **Generates TypeScript types** using graphql-codegen for proper client-side integration
3. **Supports flexible workflows** with independent phase execution
4. **Provides comprehensive configuration** for different use cases
5. **Follows GraphQL best practices** and industry standards

This implementation successfully replaces the ad-hoc type generation with a proper, maintainable solution that leverages the GraphQL ecosystem's best tools and practices.