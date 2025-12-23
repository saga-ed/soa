import { injectable } from 'inversify';

@injectable()
export class ServerUtil {
  hello(): string {
    return 'hello';
  }
}
