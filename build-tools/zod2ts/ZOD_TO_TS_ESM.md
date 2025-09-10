# Zod2ts ES Module Design Decision

## Current Implementation Overview

The zod2ts tool uses a **hybrid approach** for processing schema files:

1. **Input**: ES module files with `export const SomeSchema = z.object(...)` syntax
2. **Processing**: Transforms ES modules to CommonJS-style for controlled evaluation
3. **Output**: Clean TypeScript type definition files

## Why Not Pure ES Modules?

The current implementation transforms ES modules to CommonJS and evaluates them in a controlled function scope rather than using dynamic imports. Here's why:

### Current Approach Benefits

```javascript
// What we do now:
const originalContent = await readFile(resolvedPath, 'utf-8');
const modifiedContent = this.replaceZodImports(originalContent);
const transformedContent = this.transformESModuleExports(modifiedContent);

// Controlled evaluation with custom module scope
const func = new Function(...Object.keys(moduleScope), transformedContent + '\n; return exports;');
const module = func(...Object.values(moduleScope));
```

**Advantages:**
- ✅ **Dependency Isolation**: Can inject specific zod version via `globalThis.__bundledZod`
- ✅ **Import Control**: Replaces all zod imports with controlled bundled version
- ✅ **Cross-platform**: Works reliably in different Node.js execution contexts
- ✅ **Security**: Controlled scope prevents access to unintended globals
- ✅ **Predictable**: No module resolution path issues

### Alternative: Pure ES Module Approach

```javascript
// What we could do instead:
const module = await import(filePath);

// Extract schemas directly
for (const [name, export_] of Object.entries(module)) {
  if (this.isZodSchema(export_)) {
    schemas.set(name, export_);
  }
}
```

**Why we don't do this:**

1. **Module Resolution Complexity**: 
   - Dynamic imports require proper file:// URLs or resolved paths
   - Different behavior between Node.js versions and environments

2. **Dependency Management Issues**:
   - Can't control which zod version the schema files use
   - PNPM workspace resolution can cause version conflicts
   - Hard to ensure consistent zod instance across schemas

3. **Import Path Handling**:
   - Need to handle both absolute and relative paths correctly
   - File URL conversion complexity (`file://` protocol requirements)

## Technical Implementation Details

### ES Module → CommonJS Transformation

The `transformESModuleExports()` method converts:

```javascript
// Input (ES Module):
export const CreateUserSchema = z.object({
  name: z.string(),
  email: z.string().email()
});

// Output (CommonJS-style for evaluation):
const CreateUserSchema = z.object({
  name: z.string(),
  email: z.string().email()
});
exports.CreateUserSchema = CreateUserSchema;
```

### Zod Import Replacement

The `replaceZodImports()` method converts:

```javascript
// Input:
import { z } from 'zod';

// Output:
const { z } = globalThis.__bundledZod;
```

This ensures all schema files use the exact same zod instance, preventing version conflicts.

## When to Consider Pure ES Module Approach

You might want to switch to pure ES modules if:

1. **Simplified Architecture**: You want to remove the transformation complexity
2. **Native Module Support**: You're confident about module resolution in your environment  
3. **Standard Tooling**: You prefer to rely on Node.js native import mechanisms

## Migration Path to ES Modules

If you wanted to switch to pure ES modules, you'd need to:

```javascript
export class ZodSchemaLoader {
  async loadSchemasFromFile(filePath: string): Promise<Map<string, z.ZodSchema>> {
    try {
      // Convert to file:// URL for cross-platform compatibility
      const fileUrl = pathToFileURL(resolve(filePath));
      
      // Dynamic import
      const module = await import(fileUrl.href);
      
      const schemas = new Map<string, z.ZodSchema>();
      
      // Extract schemas
      for (const [name, export_] of Object.entries(module)) {
        if (this.isZodSchema(export_)) {
          schemas.set(name, export_);
        }
      }
      
      return schemas;
    } catch (error) {
      throw new SchemaLoadingError(`Failed to load: ${error.message}`);
    }
  }
}
```

**Trade-offs:**
- ✅ Simpler, more standard approach
- ✅ No transformation step needed
- ❌ Lose dependency isolation control
- ❌ More complex error handling for import issues
- ❌ Potential module resolution problems in complex workspace setups

## Conclusion

The current hybrid approach is well-suited for this monorepo build tool context because it prioritizes **reliability and control** over **simplicity**. The transformation overhead is minimal, and the benefits of dependency isolation and predictable execution make it a solid choice for a build tool that needs to work consistently across different environments and execution contexts.

## File History

- **2025-09-10**: Fixed malformed regex in `transformESModuleExports()` that was causing "Unexpected token 'export'" errors
- **2025-09-10**: Added proper handling for TypeScript type exports (removal from runtime evaluation)