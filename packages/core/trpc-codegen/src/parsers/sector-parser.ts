import fs from 'fs/promises';
import path from 'path';
import type { TRPCCodegenConfig } from '../types/config.js';
import type { SectorInfo } from '../types/sector.js';
import { parseRouterFile } from './router-parser.js';

export class SectorParser {
  constructor(private config: TRPCCodegenConfig, private basePath: string) {}

  async discoverSectors(): Promise<SectorInfo[]> {
    const sectorsDir = path.resolve(this.basePath, this.config.source.sectorsDir);
    
    try {
      const sectors = await fs.readdir(sectorsDir);
      const sectorInfos: SectorInfo[] = [];
      
      for (const sector of sectors) {
        const sectorPath = path.join(sectorsDir, sector);
        const stat = await fs.stat(sectorPath);
        
        if (stat.isDirectory()) {
          try {
            // Parse the router file for this sector using the configured pattern
            const sectorInfo = await this.parseSectorRouter(sectorsDir, sector);
            if (sectorInfo.endpoints.length > 0) {
              sectorInfos.push(sectorInfo);
            }
          } catch (error) {
          }
        }
      }
      
      if (sectorInfos.length === 0) {
        throw new Error(`No sectors with tRPC routers found in ${sectorsDir}`);
      }
      
      return sectorInfos;
      
    } catch (error) {
      throw new Error(`Failed to discover sectors: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async parseSectorRouter(sectorsDir: string, sectorName: string): Promise<SectorInfo> {
    // Use the configured router pattern to find the router file
    // Replace * with sectorName in the pattern
    const routerPattern = this.config.source.routerPattern
      .replace('*', sectorName)
      .replace('*', sectorName);
    const routerFilePath = path.join(sectorsDir, routerPattern);
    
    try {
      const routerContent = await fs.readFile(routerFilePath, 'utf-8');
      const endpoints = parseRouterFile(routerContent, this.config.parsing);
      
      return {
        name: sectorName,
        endpoints
      };
    } catch (error) {
      return {
        name: sectorName,
        endpoints: []
      };
    }
  }
}