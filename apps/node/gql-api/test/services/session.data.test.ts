import { describe, it, expect, beforeEach } from 'vitest';
import { sessions, createSession, getSessions, getSessionById, type Session } from '../../src/sectors/session/gql/session.data.js';

describe('session.data service', () => {
    beforeEach(() => {
        // Arrange: Clear sessions array before each test to ensure isolation
        sessions.length = 0;
    });

    describe('createSession', () => {
        it('should add a session to the sessions array', () => {
            // Arrange
            const session: Session = {
                id: '1',
                userId: 'user-123',
                token: 'token-abc',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };

            // Act
            const result = createSession(session);

            // Assert
            expect(result).toEqual(session);
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toEqual(session);
        });

        it('should return the created session', () => {
            // Arrange
            const session: Session = {
                id: '2',
                userId: 'user-456',
                token: 'token-def',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };

            // Act
            const result = createSession(session);

            // Assert
            expect(result).toBe(session);
            expect(result.id).toBe('2');
            expect(result.userId).toBe('user-456');
            expect(result.token).toBe('token-def');
        });

        it('should allow multiple sessions to be created', () => {
            // Arrange
            const session1: Session = {
                id: '1',
                userId: 'user-1',
                token: 'token-1',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            const session2: Session = {
                id: '2',
                userId: 'user-2',
                token: 'token-2',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            const session3: Session = {
                id: '3',
                userId: 'user-3',
                token: 'token-3',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };

            // Act
            createSession(session1);
            createSession(session2);
            createSession(session3);

            // Assert
            expect(sessions).toHaveLength(3);
            expect(sessions).toContainEqual(session1);
            expect(sessions).toContainEqual(session2);
            expect(sessions).toContainEqual(session3);
        });
    });

    describe('getSessions', () => {
        it('should return empty array when no sessions exist', () => {
            // Arrange - already done in beforeEach

            // Act
            const result = getSessions();

            // Assert
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });

        it('should return all sessions when sessions exist', () => {
            // Arrange
            const session1: Session = {
                id: '1',
                userId: 'user-1',
                token: 'token-1',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            const session2: Session = {
                id: '2',
                userId: 'user-2',
                token: 'token-2',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            createSession(session1);
            createSession(session2);

            // Act
            const result = getSessions();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContainEqual(session1);
            expect(result).toContainEqual(session2);
        });

        it('should return reference to the same array', () => {
            // Arrange
            const session: Session = {
                id: '1',
                userId: 'user-1',
                token: 'token-1',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            createSession(session);

            // Act
            const result = getSessions();

            // Assert
            expect(result).toBe(sessions);
        });
    });

    describe('getSessionById', () => {
        it('should return session when found by id', () => {
            // Arrange
            const session1: Session = {
                id: 'abc-123',
                userId: 'user-1',
                token: 'token-1',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            const session2: Session = {
                id: 'def-456',
                userId: 'user-2',
                token: 'token-2',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            createSession(session1);
            createSession(session2);

            // Act
            const result = getSessionById('abc-123');

            // Assert
            expect(result).toEqual(session1);
            expect(result?.id).toBe('abc-123');
        });

        it('should return undefined when session is not found', () => {
            // Arrange
            const session: Session = {
                id: '1',
                userId: 'user-1',
                token: 'token-1',
                createdAt: '2024-01-01T00:00:00.000Z',
                expiresAt: '2024-01-02T00:00:00.000Z',
            };
            createSession(session);

            // Act
            const result = getSessionById('non-existent-id');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should return undefined when sessions array is empty', () => {
            // Arrange - already done in beforeEach

            // Act
            const result = getSessionById('any-id');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should find correct session among multiple sessions', () => {
            // Arrange
            const sessionList: Session[] = [
                {
                    id: '1',
                    userId: 'user-1',
                    token: 'token-1',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    expiresAt: '2024-01-02T00:00:00.000Z',
                },
                {
                    id: '2',
                    userId: 'user-2',
                    token: 'token-2',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    expiresAt: '2024-01-02T00:00:00.000Z',
                },
                {
                    id: '3',
                    userId: 'user-3',
                    token: 'token-3',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    expiresAt: '2024-01-02T00:00:00.000Z',
                },
            ];
            sessionList.forEach(createSession);

            // Act
            const result = getSessionById('2');

            // Assert
            expect(result?.id).toBe('2');
            expect(result?.userId).toBe('user-2');
            expect(result?.token).toBe('token-2');
        });
    });
});
