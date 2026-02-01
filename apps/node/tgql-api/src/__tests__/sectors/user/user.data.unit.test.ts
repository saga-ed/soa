import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { User } from '../../../sectors/user/gql/user.type.js';
import { users, createUser, getUsers, getUserById } from '../../../sectors/user/gql/user.data.js';

describe('User Data Layer', () => {
    beforeEach(() => {
        // Arrange: Clear users array before each test
        users.length = 0;
    });

    describe('createUser', () => {
        it('should add user to users array', () => {
            // Arrange
            const newUser = Object.assign(new User(), {
                id: '123',
                name: 'John Doe',
                email: 'john@example.com',
                role: 'admin',
            });

            // Act
            const result = createUser(newUser);

            // Assert
            expect(result).toBe(newUser);
            expect(users).toHaveLength(1);
            expect(users[0]).toBe(newUser);
        });

        it('should return the created user', () => {
            // Arrange
            const newUser = Object.assign(new User(), {
                id: '456',
                name: 'Jane Smith',
                email: 'jane@example.com',
            });

            // Act
            const result = createUser(newUser);

            // Assert
            expect(result).toEqual({
                id: '456',
                name: 'Jane Smith',
                email: 'jane@example.com',
            });
        });

        it('should handle multiple users', () => {
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

            // Act
            createUser(user1);
            createUser(user2);

            // Assert
            expect(users).toHaveLength(2);
            expect(users).toContain(user1);
            expect(users).toContain(user2);
        });
    });

    describe('getUsers', () => {
        it('should return empty array when no users exist', () => {
            // Act
            const result = getUsers();

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
            });
            const user2 = Object.assign(new User(), {
                id: '2',
                name: 'User Two',
                email: 'user2@example.com',
            });
            createUser(user1);
            createUser(user2);

            // Act
            const result = getUsers();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContain(user1);
            expect(result).toContain(user2);
        });

        it('should return the same array reference as users', () => {
            // Act
            const result = getUsers();

            // Assert
            expect(result).toBe(users);
        });
    });

    describe('getUserById', () => {
        it('should return undefined when user not found', () => {
            // Act
            const result = getUserById('nonexistent');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should return user by id', () => {
            // Arrange
            const user = Object.assign(new User(), {
                id: 'target-id',
                name: 'Target User',
                email: 'target@example.com',
            });
            createUser(user);

            // Act
            const result = getUserById('target-id');

            // Assert
            expect(result).toBe(user);
            expect(result?.id).toBe('target-id');
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
            const user3 = Object.assign(new User(), {
                id: '3',
                name: 'User Three',
                email: 'user3@example.com',
            });
            createUser(user1);
            createUser(user2);
            createUser(user3);

            // Act
            const result = getUserById('2');

            // Assert
            expect(result).toBe(user2);
            expect(result?.name).toBe('User Two');
        });

        it('should handle users without optional role field', () => {
            // Arrange
            const user = Object.assign(new User(), {
                id: 'no-role',
                name: 'No Role User',
                email: 'norole@example.com',
            });
            createUser(user);

            // Act
            const result = getUserById('no-role');

            // Assert
            expect(result).toBe(user);
            expect(result?.role).toBeUndefined();
        });
    });
});
