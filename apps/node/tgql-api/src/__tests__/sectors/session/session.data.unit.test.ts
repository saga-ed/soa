import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../../../sectors/session/gql/session.type.js';
import { sessions, createSession, getSessions, getSessionById } from '../../../sectors/session/gql/session.data.js';

describe('Session Data Layer', () => {
    beforeEach(() => {
        // Arrange: Clear sessions array before each test
        sessions.length = 0;
    });

    describe('createSession', () => {
        it('should add session to sessions array', () => {
            // Arrange
            const newSession = Object.assign(new Session(), {
                id: 'session-123',
                tutor: 'John Doe',
                student: 'Jane Smith',
                date: new Date('2024-01-15'),
                duration: 60,
                notes: 'Good progress',
            });

            // Act
            const result = createSession(newSession);

            // Assert
            expect(result).toBe(newSession);
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toBe(newSession);
        });

        it('should return the created session', () => {
            // Arrange
            const newSession = Object.assign(new Session(), {
                id: 'session-456',
                tutor: 'Alice Brown',
                student: 'Bob Wilson',
                date: new Date('2024-03-01'),
                duration: 90,
            });

            // Act
            const result = createSession(newSession);

            // Assert
            expect(result.id).toBe('session-456');
            expect(result.tutor).toBe('Alice Brown');
            expect(result.student).toBe('Bob Wilson');
            expect(result.duration).toBe(90);
        });

        it('should handle multiple sessions', () => {
            // Arrange
            const session1 = Object.assign(new Session(), {
                id: '1',
                tutor: 'Tutor One',
                student: 'Student One',
                date: new Date('2024-01-01'),
                duration: 60,
            });
            const session2 = Object.assign(new Session(), {
                id: '2',
                tutor: 'Tutor Two',
                student: 'Student Two',
                date: new Date('2024-02-01'),
                duration: 45,
            });

            // Act
            createSession(session1);
            createSession(session2);

            // Assert
            expect(sessions).toHaveLength(2);
            expect(sessions).toContain(session1);
            expect(sessions).toContain(session2);
        });
    });

    describe('getSessions', () => {
        it('should return empty array when no sessions exist', () => {
            // Act
            const result = getSessions();

            // Assert
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });

        it('should return all sessions', () => {
            // Arrange
            const session1 = Object.assign(new Session(), {
                id: '1',
                tutor: 'Tutor One',
                student: 'Student One',
                date: new Date('2024-01-01'),
                duration: 60,
            });
            const session2 = Object.assign(new Session(), {
                id: '2',
                tutor: 'Tutor Two',
                student: 'Student Two',
                date: new Date('2024-02-01'),
                duration: 45,
            });
            createSession(session1);
            createSession(session2);

            // Act
            const result = getSessions();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContain(session1);
            expect(result).toContain(session2);
        });

        it('should return the same array reference as sessions', () => {
            // Act
            const result = getSessions();

            // Assert
            expect(result).toBe(sessions);
        });
    });

    describe('getSessionById', () => {
        it('should return undefined when session not found', () => {
            // Act
            const result = getSessionById('nonexistent');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should return session by id', () => {
            // Arrange
            const session = Object.assign(new Session(), {
                id: 'target-session',
                tutor: 'Jane Tutor',
                student: 'John Student',
                date: new Date('2024-01-01'),
                duration: 60,
            });
            createSession(session);

            // Act
            const result = getSessionById('target-session');

            // Assert
            expect(result).toBe(session);
            expect(result?.id).toBe('target-session');
        });

        it('should return correct session when multiple sessions exist', () => {
            // Arrange
            const session1 = Object.assign(new Session(), {
                id: '1',
                tutor: 'Tutor One',
                student: 'Student One',
                date: new Date('2024-01-01'),
                duration: 60,
            });
            const session2 = Object.assign(new Session(), {
                id: '2',
                tutor: 'Tutor Two',
                student: 'Student Two',
                date: new Date('2024-02-01'),
                duration: 45,
            });
            const session3 = Object.assign(new Session(), {
                id: '3',
                tutor: 'Tutor Three',
                student: 'Student Three',
                date: new Date('2024-03-01'),
                duration: 30,
            });
            createSession(session1);
            createSession(session2);
            createSession(session3);

            // Act
            const result = getSessionById('2');

            // Assert
            expect(result).toBe(session2);
            expect(result?.tutor).toBe('Tutor Two');
        });
    });
});
