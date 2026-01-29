import { readFileSync } from 'node:fs';
import type { TypeInfo, InputInfo, FieldInfo } from '../types/sector.js';
import type { TGQLCodegenConfig } from '../types/config.js';

export class TypeParser {
  constructor(private config: TGQLCodegenConfig) {}

  async parseType(filePath: string, sectorName: string): Promise<TypeInfo | null> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      
      // Extract ObjectType class
      const typeMatch = content.match(/@ObjectType\(\)\s*export\s+class\s+(\w+)/);
      if (!typeMatch || !typeMatch[1]) {
        console.warn(`No ObjectType found in ${filePath}`);
        return null;
      }

      const className = typeMatch[1];
      console.log(`  🏷️  Found type: ${className}`);

      // Parse fields
      const fields = this.parseFields(content);

      return {
        className,
        filePath,
        sectorName,
        fields
      };
    } catch (error) {
      console.error(`Error parsing type ${filePath}:`, error);
      return null;
    }
  }

  async parseInput(filePath: string, sectorName: string): Promise<InputInfo | null> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      
      // Extract InputType class
      const inputMatch = content.match(/@InputType\(\)\s*export\s+class\s+(\w+)/);
      if (!inputMatch || !inputMatch[1]) {
        console.warn(`No InputType found in ${filePath}`);
        return null;
      }

      const className = inputMatch[1];
      console.log(`  📝 Found input: ${className}`);

      // Parse fields
      const fields = this.parseFields(content);

      return {
        className,
        filePath,
        sectorName,
        fields
      };
    } catch (error) {
      console.error(`Error parsing input ${filePath}:`, error);
      return null;
    }
  }

  private parseFields(content: string): FieldInfo[] {
    const fields: FieldInfo[] = [];
    
    // Match @Field decorators with their properties
    const fieldPattern = /@Field\s*\((?:\s*\(\)\s*=>\s*([\[\]\w]+))?(?:\s*,\s*\{[^}]*nullable[^}]*\})?\s*\)\s*(\w+)(?:\?\s*)?:\s*([\w\[\]]+)/g;
    
    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const [fullMatch, decoratorType, fieldName, propertyType] = match;
      
      // Skip if required parts are missing
      if (!fieldName || !fullMatch) {
        continue;
      }
      
      // Determine if field is nullable
      const nullable = fullMatch.includes('nullable') || fullMatch.includes(`${fieldName}?`);
      
      // Determine if field is array
      const isArray = (decoratorType?.includes('[') && decoratorType?.includes(']')) || 
                     (propertyType?.includes('[') && propertyType?.includes(']'));
      
      // Clean up type name
      let cleanType = decoratorType || propertyType;
      cleanType = cleanType?.replace(/[\[\]]/g, '') || 'any';
      
      fields.push({
        name: fieldName,
        type: cleanType,
        nullable,
        isArray
      });

      console.log(`    🔸 Field: ${fieldName}: ${isArray ? '[' : ''}${cleanType}${isArray ? ']' : ''}${nullable ? '?' : ''}`);
    }

    return fields;
  }
}