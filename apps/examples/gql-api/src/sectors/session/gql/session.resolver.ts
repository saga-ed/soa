import { inject } from 'inversify';
import { AbstractGQLController, type ResolverMap } from '@hipponot/soa-api-core';
import type { ILogger } from '@hipponot/soa-logger';
import { sessions, createSession as createSessionData, getSessionById } from './session.data.js';
import { v4 as uuidv4 } from 'uuid';

export class SessionResolver extends AbstractGQLController {
  readonly sectorName = 'session';

  constructor(@inject('ILogger') logger: ILogger) {
    super(logger);
  }

  getResolvers(): ResolverMap {
    return {
      Query: {
        allSessions: () => {
          this.logger.debug('Fetching all sessions');
          return sessions;
        },
        session: (_: any, { id }: { id: string }) => {
          this.logger.debug(`Fetching session with id: ${id}`);
          return getSessionById(id);
        },
      },
      Mutation: {
        createSession: (_: any, { input }: { input: { userId: string } }) => {
          this.logger.debug(`Creating session for user: ${input.userId}`);
          const now = new Date();
          const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
          const session = {
            id: uuidv4(),
            userId: input.userId,
            token: `token_${uuidv4()}`,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
          };
          return createSessionData(session);
        },
      },
    };
  }
}
