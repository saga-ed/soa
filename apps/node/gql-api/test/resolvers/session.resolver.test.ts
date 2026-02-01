import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container } from 'inversify';
import { SessionResolver } from '../../src/sectors/session/gql/session.resolver.js';
import type { ILogger } from '@saga-ed/soa-logger';
import { sessions, createSession, getSessionById } from '../../src/sectors/session/gql/session.data.js';

describe('SessionResolver', () => {
    let container: Container;
    let resolver: SessionResolver;
    let mockLogger: ILogger;

    beforeEach(() => {
        // Arrange: Set up test container with mocks
        container = new Container();

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        } as any;

        container.bind<ILogger>('ILogger').toConstantValue(mockLogger);
        container.bind(SessionResolver).toSelf();

        resolver = container.get(SessionResolver);

        // Clear sessions array before each test
        sessions.length = 0;
    });

    describe('Query: allSessions', () => {
        it('should return empty array when no sessions exist', () => {
            // Arrange - already done in beforeEach

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.allSessions?.();

            // Assert
            expect(result).toEqual([]);
            expect(mockLogger.debug).toHaveBeenCalledWith('Fetching all sessions');
        });

        it('should return all sessions when sessions exist', () => {
            // Arrange
            const session1 = {
                id: '1',
                userId: 'user-1',
                token: 'token-1',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            const session2 = {
                id: '2',
                userId: 'user-2',
                token: 'token-2',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            createSession(session1);
            createSession(session2);

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.allSessions?.();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContainEqual(session1);
            expect(result).toContainEqual(session2);
        });
    });

    describe('Query: session', () => {
        it('should return session by id when session exists', () => {
            // Arrange
            const session = {
                id: 'session-123',
                userId: 'user-456',
                token: 'token-abc',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            createSession(session);

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.session?.(null, { id: 'session-123' });

            // Assert
            expect(result).toEqual(session);
            expect(mockLogger.debug).toHaveBeenCalledWith('Fetching session with id: session-123');
        });

        it('should return undefined when session does not exist', () => {
            // Arrange - no sessions in array

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.session?.(null, { id: 'non-existent' });

            // Assert
            expect(result).toBeUndefined();
        });
    });

    describe('Mutation: createSession', () => {
        it('should create and return a new session with valid properties', () => {
            // Arrange
            const input = { userId: 'user-789' };
            const beforeCreate = new Date();

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Mutation?.createSession?.(null, { input });
            const afterCreate = new Date();

            // Assert
            expect(result).toBeDefined();
            expect(result?.userId).toBe('user-789');
            expect(result?.id).toBeDefined();
            expect(typeof result?.id).toBe('string');
            expect(result?.token).toMatch(/^token_/);
            expect(result?.createdAt).toBeDefined();
            expect(result?.expiresAt).toBeDefined();
            expect(sessions).toHaveLength(1);
            expect(mockLogger.debug).toHaveBeenCalledWith('Creating session for user: user-789');
        });

        it('should set expiration to 24 hours from creation', () => {
            // Arrange
            const input = { userId: 'user-999' };

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Mutation?.createSession?.(null, { input });

            // Assert
            const createdAt = new Date(result?.createdAt || '');
            const expiresAt = new Date(result?.expiresAt || '');
            const diffInHours = (expiresAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
            expect(diffInHours).toBe(24);
        });

        it('should generate unique IDs and tokens for different sessions', () => {
            // Arrange
            const input1 = { userId: 'user-1' };
            const input2 = { userId: 'user-2' };

            // Act
            const resolvers = resolver.getResolvers();
            const session1 = resolvers.Mutation?.createSession?.(null, { input: input1 });
            const session2 = resolvers.Mutation?.createSession?.(null, { input: input2 });

            // Assert
            expect(session1?.id).not.toBe(session2?.id);
            expect(session1?.token).not.toBe(session2?.token);
            expect(sessions).toHaveLength(2);
        });
    });

    describe('sectorName', () => {
        it('should have correct sector name', () => {
            // Assert
            expect(resolver.sectorName).toBe('session');
        });
    });
});
