import {
  Controller,
  Get,
  Req,
  Res,
  HeaderParams,
  getMetadataArgsStorage,
} from 'routing-controllers';
import type { Request, Response } from 'express';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';
import { AbstractRestController } from './abstract-rest-controller.js';

const SECTOR = 'sectors';

@injectable()
@Controller(`/${SECTOR}`)
export class SectorsController extends AbstractRestController {
  readonly sectorName = SECTOR;

  constructor(@inject('ILogger') logger: ILogger) {
    super(logger, SECTOR);
  }

  @Get('/list')
  async listSectors(@Req() req: Request, @Res() res: Response, @HeaderParams() headers: any) {
    const storage = getMetadataArgsStorage();
    const controllers = storage.controllers;
    const actions = storage.actions;

    // Build a map of controller (sector) to its routes
    const sectors = controllers.map((ctrl: { target: any; route: string | RegExp }) => {
      const sectorName = ctrl.target.name;
      const baseRoute = typeof ctrl.route === 'string' ? ctrl.route : ctrl.route.toString();
      const routes = actions
        .filter(
          (a: { target: any; type: string; route: string | RegExp; method: string }) =>
            a.target === ctrl.target
        )
        .map((a: { type: string; route: string | RegExp; method: string }) => ({
          method: a.type.toUpperCase(),
          path: baseRoute + (typeof a.route === 'string' ? a.route : a.route.toString()),
          handler: a.method,
        }));
      return { sectorName, baseRoute, routes };
    });

    // If Accept header prefers HTML, render a pretty table
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      let html = `<html><head><title>Sectors & Routes</title>
        <style>
          body { font-family: sans-serif; background: #f9f9f9; }
          table { border-collapse: collapse; width: 90%; margin: 2em auto; background: #fff; }
          th, td { border: 1px solid #ccc; padding: 0.5em 1em; text-align: left; }
          th { background: #eee; }
          tr:nth-child(even) { background: #f6f6f6; }
          h2 { margin-top: 2em; text-align: center; }
        </style>
      </head><body>`;
      html += `<h2>Registered Sectors & Routes</h2>`;
      for (const sector of sectors) {
        html += `<h3>${sector.sectorName} <span style='font-weight:normal;color:#888;'>(${sector.baseRoute})</span></h3>`;
        html += `<table><thead><tr><th>Method</th><th>Path</th><th>Handler</th></tr></thead><tbody>`;
        for (const route of sector.routes) {
          html += `<tr><td>${route.method}</td><td>${route.path}</td><td>${route.handler}</td></tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</body></html>`;
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }
    // Otherwise, return JSON
    return sectors;
  }

  async init() {}
}
