import { describe, it, expect, beforeEach } from 'vitest';
import { users, createUser, getUsers, getUserById, type User } from '../../src/sectors/user/gql/user.data.js';

describe('user.data service', () => {
    beforeEach(() => {
        // Arrange: Clear users array before each test to ensure isolation
        users.length = 0;
    });

    describe('createUser', () => {
        it('should add a user to the users array', () => {
            // Arrange
            const user: User = { id: '1', name: 'Alice', email: 'alice@example.com' };

            // Act
            const result = createUser(user);

            // Assert
            expect(result).toEqual(user);
            expect(users).toHaveLength(1);
            expect(users[0]).toEqual(user);
        });

        it('should return the created user', () => {
            // Arrange
            const user: User = { id: '2', name: 'Bob', email: 'bob@example.com' };

            // Act
            const result = createUser(user);

            // Assert
            expect(result).toBe(user);
            expect(result.id).toBe('2');
            expect(result.name).toBe('Bob');
            expect(result.email).toBe('bob@example.com');
        });

        it('should allow multiple users to be created', () => {
            // Arrange
            const user1: User = { id: '1', name: 'User1', email: 'user1@example.com' };
            const user2: User = { id: '2', name: 'User2', email: 'user2@example.com' };
            const user3: User = { id: '3', name: 'User3', email: 'user3@example.com' };

            // Act
            createUser(user1);
            createUser(user2);
            createUser(user3);

            // Assert
            expect(users).toHaveLength(3);
            expect(users).toContainEqual(user1);
            expect(users).toContainEqual(user2);
            expect(users).toContainEqual(user3);
        });
    });

    describe('getUsers', () => {
        it('should return empty array when no users exist', () => {
            // Arrange - already done in beforeEach

            // Act
            const result = getUsers();

            // Assert
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });

        it('should return all users when users exist', () => {
            // Arrange
            const user1: User = { id: '1', name: 'Alice', email: 'alice@example.com' };
            const user2: User = { id: '2', name: 'Bob', email: 'bob@example.com' };
            createUser(user1);
            createUser(user2);

            // Act
            const result = getUsers();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContainEqual(user1);
            expect(result).toContainEqual(user2);
        });

        it('should return reference to the same array', () => {
            // Arrange
            const user: User = { id: '1', name: 'Charlie', email: 'charlie@example.com' };
            createUser(user);

            // Act
            const result = getUsers();

            // Assert
            expect(result).toBe(users);
        });
    });

    describe('getUserById', () => {
        it('should return user when found by id', () => {
            // Arrange
            const user1: User = { id: 'abc-123', name: 'Dave', email: 'dave@example.com' };
            const user2: User = { id: 'def-456', name: 'Eve', email: 'eve@example.com' };
            createUser(user1);
            createUser(user2);

            // Act
            const result = getUserById('abc-123');

            // Assert
            expect(result).toEqual(user1);
            expect(result?.id).toBe('abc-123');
        });

        it('should return undefined when user is not found', () => {
            // Arrange
            const user: User = { id: '1', name: 'Frank', email: 'frank@example.com' };
            createUser(user);

            // Act
            const result = getUserById('non-existent-id');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should return undefined when users array is empty', () => {
            // Arrange - already done in beforeEach

            // Act
            const result = getUserById('any-id');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should find correct user among multiple users', () => {
            // Arrange
            const users: User[] = [
                { id: '1', name: 'User1', email: 'user1@example.com' },
                { id: '2', name: 'User2', email: 'user2@example.com' },
                { id: '3', name: 'User3', email: 'user3@example.com' },
            ];
            users.forEach(createUser);

            // Act
            const result = getUserById('2');

            // Assert
            expect(result?.id).toBe('2');
            expect(result?.name).toBe('User2');
        });
    });
});
