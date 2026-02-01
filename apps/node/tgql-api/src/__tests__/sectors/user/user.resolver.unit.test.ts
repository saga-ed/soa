import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container } from 'inversify';
import { UserResolver } from '../../../sectors/user/gql/user.resolver.js';
import { User } from '../../../sectors/user/gql/user.type.js';
import { UserInput } from '../../../sectors/user/gql/user.input.js';
import { users, createUser } from '../../../sectors/user/gql/user.data.js';
import type { ILogger } from '@saga-ed/soa-logger';

// Mock uuid
vi.mock('uuid', () => ({
    v4: vi.fn(() => 'mocked-uuid'),
}));

describe('UserResolver', () => {
    let container: Container;
    let resolver: UserResolver;
    let mockLogger: ILogger;

    beforeEach(() => {
        // Arrange: Clear users and create test container
        users.length = 0;
        container = new Container();

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            fatal: vi.fn(),
            trace: vi.fn(),
        } as unknown as ILogger;

        container.bind<ILogger>('ILogger').toConstantValue(mockLogger);
        container.bind(UserResolver).toSelf();

        resolver = container.get(UserResolver);
    });

    describe('constructor', () => {
        it('should initialize with correct sector name', () => {
            // Assert
            expect(resolver.sectorName).toBe('user');
        });

        it('should set logger from DI', () => {
            // Assert
            expect(resolver['logger']).toBe(mockLogger);
        });
    });

    describe('allUsers', () => {
        it('should return empty array when no users exist', () => {
            // Act
            const result = resolver.allUsers();

            // Assert
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });

        it('should return all users', () => {
            // Arrange
            const user1 = Object.assign(new User(), {
                id: '1',
                name: 'User One',
                email: 'user1@example.com',
                role: 'admin',
            });
            const user2 = Object.assign(new User(), {
                id: '2',
                name: 'User Two',
                email: 'user2@example.com',
                role: 'user',
            });
            createUser(user1);
            createUser(user2);

            // Act
            const result = resolver.allUsers();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContain(user1);
            expect(result).toContain(user2);
        });

        it('should return users array directly', () => {
            // Act
            const result = resolver.allUsers();

            // Assert
            expect(result).toBe(users);
        });
    });

    describe('user', () => {
        it('should return undefined when user not found', () => {
            // Act
            const result = resolver.user('nonexistent-id');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should return user by id', () => {
            // Arrange
            const user = Object.assign(new User(), {
                id: 'target-id',
                name: 'Target User',
                email: 'target@example.com',
                role: 'admin',
            });
            createUser(user);

            // Act
            const result = resolver.user('target-id');

            // Assert
            expect(result).toBe(user);
            expect(result?.name).toBe('Target User');
        });

        it('should return correct user when multiple users exist', () => {
            // Arrange
            const user1 = Object.assign(new User(), {
                id: '1',
                name: 'User One',
                email: 'user1@example.com',
            });
            const user2 = Object.assign(new User(), {
                id: '2',
                name: 'User Two',
                email: 'user2@example.com',
            });
            createUser(user1);
            createUser(user2);

            // Act
            const result = resolver.user('2');

            // Assert
            expect(result).toBe(user2);
        });
    });

    describe('addUser', () => {
        it('should create user with generated id', () => {
            // Arrange
            const input: UserInput = {
                name: 'New User',
                email: 'new@example.com',
                role: 'admin',
            };

            // Act
            const result = resolver.addUser(input);

            // Assert
            expect(result).toBeInstanceOf(User);
            expect(result.id).toBe('mocked-uuid');
            expect(result.name).toBe('New User');
            expect(result.email).toBe('new@example.com');
            expect(result.role).toBe('admin');
        });

        it('should add user to users array', () => {
            // Arrange
            const input: UserInput = {
                name: 'New User',
                email: 'new@example.com',
            };

            // Act
            resolver.addUser(input);

            // Assert
            expect(users).toHaveLength(1);
            expect(users[0].name).toBe('New User');
        });

        it('should handle optional role field', () => {
            // Arrange
            const input: UserInput = {
                name: 'No Role User',
                email: 'norole@example.com',
            };

            // Act
            const result = resolver.addUser(input);

            // Assert
            expect(result.name).toBe('No Role User');
            expect(result.email).toBe('norole@example.com');
            expect(result.role).toBeUndefined();
        });

        it('should return the created user', () => {
            // Arrange
            const input: UserInput = {
                name: 'Test User',
                email: 'test@example.com',
                role: 'user',
            };

            // Act
            const result = resolver.addUser(input);

            // Assert
            expect(users[0]).toBe(result);
        });

        it('should create multiple users with unique ids', () => {
            // Arrange
            const input1: UserInput = {
                name: 'User One',
                email: 'user1@example.com',
            };
            const input2: UserInput = {
                name: 'User Two',
                email: 'user2@example.com',
            };

            // Act
            const result1 = resolver.addUser(input1);
            const result2 = resolver.addUser(input2);

            // Assert
            expect(users).toHaveLength(2);
            expect(result1.id).toBe('mocked-uuid');
            expect(result2.id).toBe('mocked-uuid');
        });
    });
});
