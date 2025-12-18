import { inject } from 'inversify';
import { AbstractGQLController, type ResolverMap } from '@saga-ed/soa-api-core';
import type { ILogger } from '@saga-ed/soa-logger';
import { users, createUser, getUserById } from './user.data.js';
import { v4 as uuidv4 } from 'uuid';

export class UserResolver extends AbstractGQLController {
  readonly sectorName = 'user';

  constructor(@inject('ILogger') logger: ILogger) {
    super(logger);
  }

  getResolvers(): ResolverMap {
    return {
      Query: {
        allUsers: () => {
          this.logger.debug('Fetching all users');
          return users;
        },
        user: (_: any, { id }: { id: string }) => {
          this.logger.debug(`Fetching user with id: ${id}`);
          return getUserById(id);
        },
      },
      Mutation: {
        addUser: (_: any, { input }: { input: { name: string; email: string } }) => {
          this.logger.debug(`Creating user: ${input.name}`);
          const user = { id: uuidv4(), ...input };
          return createUser(user);
        },
      },
    };
  }
}
