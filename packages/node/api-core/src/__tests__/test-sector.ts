import { JsonController, Get } from 'routing-controllers';
import { injectable } from 'inversify';

@injectable()
@JsonController('/test')
export class TestSector {
  @Get('/')
  getTest() {
    return { ok: true };
  }
}
