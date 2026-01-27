import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { glob } from 'glob';
import type { SectorInfo, ResolverInfo, TypeInfo, InputInfo } from '../types/sector.js';
import type { TGQLCodegenConfig } from '../types/config.js';
import { ResolverParser } from './resolver-parser.js';
import { TypeParser } from './type-parser.js';

export class SectorParser {
  constructor(
    private config: TGQLCodegenConfig,
    private resolverParser: ResolverParser,
    private typeParser: TypeParser
  ) {}

  async parseSectors(): Promise<SectorInfo[]> {
    const sectorsDir = resolve(this.config.source.sectorsDir);
    
    console.log(`🔍 Scanning sectors in: ${sectorsDir}`);
    
    if (!statSync(sectorsDir).isDirectory()) {
      throw new Error(`Sectors directory not found: ${sectorsDir}`);
    }

    const sectorDirs = readdirSync(sectorsDir).filter(name => {
      const fullPath = join(sectorsDir, name);
      return statSync(fullPath).isDirectory();
    });

    console.log(`📂 Found ${sectorDirs.length} sector directories: ${sectorDirs.join(', ')}`);

    const sectors: SectorInfo[] = [];
    
    for (const sectorName of sectorDirs) {
      const sectorInfo = await this.parseSector(sectorName, sectorsDir);
      if (sectorInfo.resolvers.length > 0 || sectorInfo.types.length > 0) {
        sectors.push(sectorInfo);
      }
    }

    return sectors;
  }

  private async parseSector(sectorName: string, sectorsDir: string): Promise<SectorInfo> {
    const sectorPath = join(sectorsDir, sectorName);
    
    console.log(`🔍 Parsing sector: ${sectorName}`);
    
    // Find resolver files - remove the leading */ from the pattern since we're already in the sector directory
    const resolverPattern = join(sectorPath, this.config.source.resolverPattern.replace(/^\*\/?/, ''));
    const resolverFiles = await glob(resolverPattern);
    
    // Find type files
    const typePattern = join(sectorPath, this.config.source.typePattern.replace(/^\*\/?/, ''));
    const typeFiles = await glob(typePattern);
    
    // Find input files
    const inputPattern = join(sectorPath, this.config.source.inputPattern.replace(/^\*\/?/, ''));
    const inputFiles = await glob(inputPattern);

    console.log(`  📄 Resolver files: ${resolverFiles.length}`);
    console.log(`  📄 Type files: ${typeFiles.length}`);
    console.log(`  📄 Input files: ${inputFiles.length}`);

    const resolvers: ResolverInfo[] = [];
    const types: TypeInfo[] = [];
    const inputs: InputInfo[] = [];

    // Parse resolvers
    for (const filePath of resolverFiles) {
      const resolverInfo = await this.resolverParser.parseResolver(filePath, sectorName);
      if (resolverInfo) {
        resolvers.push(resolverInfo);
      }
    }

    // Parse types
    for (const filePath of typeFiles) {
      const typeInfo = await this.typeParser.parseType(filePath, sectorName);
      if (typeInfo) {
        types.push(typeInfo);
      }
    }

    // Parse inputs
    for (const filePath of inputFiles) {
      const inputInfo = await this.typeParser.parseInput(filePath, sectorName);
      if (inputInfo) {
        inputs.push(inputInfo);
      }
    }

    return {
      name: sectorName,
      resolvers,
      types,
      inputs
    };
  }
}