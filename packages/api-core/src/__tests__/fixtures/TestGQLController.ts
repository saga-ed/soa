import { injectable, inject } from 'inversify';
import { ObjectType, Field, Query, Resolver } from 'type-graphql';
import type { ILogger } from '@saga-ed/soa-logger';
import { AbstractTGQLController } from '../../abstract-tgql-controller.js';

@ObjectType()
export class HelloResponse {
  @Field(() => String)
  message!: string;
}

@injectable()
@Resolver()
export class TestGQLController extends AbstractTGQLController {
  sectorName = 'test-gql';

  @Query(() => HelloResponse)
  async hello(): Promise<HelloResponse> {
    this.logger.info('Hello query executed');
    return {
      message: 'Hello from TestGQLController!',
    };
  }
}
