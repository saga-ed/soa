import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container } from 'inversify';
import { UserResolver } from '../../src/sectors/user/gql/user.resolver.js';
import type { ILogger } from '@saga-ed/soa-logger';
import { users, createUser, getUserById } from '../../src/sectors/user/gql/user.data.js';

describe('UserResolver', () => {
    let container: Container;
    let resolver: UserResolver;
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
        container.bind(UserResolver).toSelf();

        resolver = container.get(UserResolver);

        // Clear users array before each test
        users.length = 0;
    });

    describe('Query: allUsers', () => {
        it('should return empty array when no users exist', () => {
            // Arrange - already done in beforeEach

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.allUsers?.();

            // Assert
            expect(result).toEqual([]);
            expect(mockLogger.debug).toHaveBeenCalledWith('Fetching all users');
        });

        it('should return all users when users exist', () => {
            // Arrange
            const user1 = { id: '1', name: 'Alice', email: 'alice@example.com' };
            const user2 = { id: '2', name: 'Bob', email: 'bob@example.com' };
            createUser(user1);
            createUser(user2);

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.allUsers?.();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContainEqual(user1);
            expect(result).toContainEqual(user2);
        });
    });

    describe('Query: user', () => {
        it('should return user by id when user exists', () => {
            // Arrange
            const user = { id: 'test-id-123', name: 'Charlie', email: 'charlie@example.com' };
            createUser(user);

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.user?.(null, { id: 'test-id-123' });

            // Assert
            expect(result).toEqual(user);
            expect(mockLogger.debug).toHaveBeenCalledWith('Fetching user with id: test-id-123');
        });

        it('should return undefined when user does not exist', () => {
            // Arrange - no users in array

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Query?.user?.(null, { id: 'non-existent' });

            // Assert
            expect(result).toBeUndefined();
        });
    });

    describe('Mutation: addUser', () => {
        it('should create and return a new user', () => {
            // Arrange
            const input = { name: 'Dave', email: 'dave@example.com' };

            // Act
            const resolvers = resolver.getResolvers();
            const result = resolvers.Mutation?.addUser?.(null, { input });

            // Assert
            expect(result).toBeDefined();
            expect(result?.name).toBe('Dave');
            expect(result?.email).toBe('dave@example.com');
            expect(result?.id).toBeDefined();
            expect(typeof result?.id).toBe('string');
            expect(users).toHaveLength(1);
            expect(mockLogger.debug).toHaveBeenCalledWith('Creating user: Dave');
        });

        it('should generate unique IDs for different users', () => {
            // Arrange
            const input1 = { name: 'User1', email: 'user1@example.com' };
            const input2 = { name: 'User2', email: 'user2@example.com' };

            // Act
            const resolvers = resolver.getResolvers();
            const user1 = resolvers.Mutation?.addUser?.(null, { input: input1 });
            const user2 = resolvers.Mutation?.addUser?.(null, { input: input2 });

            // Assert
            expect(user1?.id).not.toBe(user2?.id);
            expect(users).toHaveLength(2);
        });
    });

    describe('sectorName', () => {
        it('should have correct sector name', () => {
            // Assert
            expect(resolver.sectorName).toBe('user');
        });
    });
});
