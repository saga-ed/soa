import { describe, it, expect, beforeAll } from 'vitest';
import { ControllerLoader } from '../utils/loadControllers.js';
import { AbstractRestController } from '../abstract-rest-controller.js';
import { AbstractTGQLController } from '../abstract-tgql-controller.js';
import { Container } from 'inversify';
import { PinoLogger } from '@hipponot/soa-logger';
import type { ILogger, PinoLoggerConfig } from '@hipponot/soa-logger';
import path from 'node:path';

const fixturesDir = path.join(__dirname, 'fixtures');
const dummyRestControllerGlob = path.join(fixturesDir, 'DummyRestController.ts');
const dummyGQLControllerGlob = path.join(fixturesDir, 'DummyGQLController.ts');

let controllerLoader: ControllerLoader;

beforeAll(() => {
  const container = new Container();
  
  // Logger configuration
  const loggerConfig: PinoLoggerConfig = {
    configType: 'PINO_LOGGER',
    level: 'info',
    isExpressContext: true,
    prettyPrint: true,
  };
  
  container.bind<PinoLoggerConfig>('PinoLoggerConfig').toConstantValue(loggerConfig);
  container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();
  container.bind(ControllerLoader).toSelf().inSingletonScope();
  controllerLoader = container.get(ControllerLoader);
});

describe('ControllerLoader', () => {
  it('loads a controller that extends AbstractRestController', async () => {
    const controllers = await controllerLoader.loadControllers(dummyRestControllerGlob, AbstractRestController);
    expect(controllers).toHaveLength(1);
    expect(controllers[0].name).toBe('DummyRestController');
  });

  it('loads a controller that extends AbstractTGQLController', async () => {
    const controllers = await controllerLoader.loadControllers(dummyGQLControllerGlob, AbstractTGQLController);
    expect(controllers).toHaveLength(1);
    expect(controllers[0].name).toBe('DummyGQLController');
  });

  it('throws an error if no controllers are found', async () => {
    const noMatchGlob = path.join(fixturesDir, 'NoSuchController.ts');
    await expect(controllerLoader.loadControllers(noMatchGlob, AbstractRestController)).rejects.toThrow(
      'No valid REST controllers found'
    );
  });
});
