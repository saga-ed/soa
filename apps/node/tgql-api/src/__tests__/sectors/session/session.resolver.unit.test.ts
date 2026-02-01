import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container } from 'inversify';
import { SessionResolver } from '../../../sectors/session/gql/session.resolver.js';
import { Session } from '../../../sectors/session/gql/session.type.js';
import { SessionInput } from '../../../sectors/session/gql/session.input.js';
import { sessions, createSession } from '../../../sectors/session/gql/session.data.js';
import type { ILogger } from '@saga-ed/soa-logger';

// Mock uuid
vi.mock('uuid', () => ({
    v4: vi.fn(() => 'mocked-session-uuid'),
}));

describe('SessionResolver', () => {
    let container: Container;
    let resolver: SessionResolver;
    let mockLogger: ILogger;

    beforeEach(() => {
        // Arrange: Clear sessions and create test container
        sessions.length = 0;
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
        container.bind(SessionResolver).toSelf();

        resolver = container.get(SessionResolver);
    });

    describe('constructor', () => {
        it('should initialize with correct sector name', () => {
            // Assert
            expect(resolver.sectorName).toBe('session');
        });

        it('should set logger from DI', () => {
            // Assert
            expect(resolver['logger']).toBe(mockLogger);
        });
    });

    describe('allSessions', () => {
        it('should return empty array when no sessions exist', () => {
            // Act
            const result = resolver.allSessions();

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
            const result = resolver.allSessions();

            // Assert
            expect(result).toHaveLength(2);
            expect(result).toContain(session1);
            expect(result).toContain(session2);
        });

        it('should return sessions array directly', () => {
            // Act
            const result = resolver.allSessions();

            // Assert
            expect(result).toBe(sessions);
        });
    });

    describe('session', () => {
        it('should return undefined when session not found', () => {
            // Act
            const result = resolver.session('nonexistent-id');

            // Assert
            expect(result).toBeUndefined();
        });

        it('should return session by id', () => {
            // Arrange
            const session = Object.assign(new Session(), {
                id: 'target-id',
                tutor: 'Jane Tutor',
                student: 'John Student',
                date: new Date('2024-01-01'),
                duration: 60,
            });
            createSession(session);

            // Act
            const result = resolver.session('target-id');

            // Assert
            expect(result).toBe(session);
            expect(result?.tutor).toBe('Jane Tutor');
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
            createSession(session1);
            createSession(session2);

            // Act
            const result = resolver.session('2');

            // Assert
            expect(result).toBe(session2);
        });
    });

    describe('addSession', () => {
        it('should create session with generated id', () => {
            // Arrange
            const testDate = new Date('2024-01-15');
            const input: SessionInput = {
                tutor: 'John Tutor',
                student: 'Jane Student',
                date: testDate,
                duration: 60,
                notes: 'Good progress',
            };

            // Act
            const result = resolver.addSession(input);

            // Assert
            expect(result).toBeInstanceOf(Session);
            expect(result.id).toBe('mocked-session-uuid');
            expect(result.tutor).toBe('John Tutor');
            expect(result.student).toBe('Jane Student');
            expect(result.date).toBe(testDate);
            expect(result.duration).toBe(60);
            expect(result.notes).toBe('Good progress');
        });

        it('should add session to sessions array', () => {
            // Arrange
            const input: SessionInput = {
                tutor: 'Alice Brown',
                student: 'Bob Wilson',
                date: new Date('2024-03-01'),
                duration: 90,
            };

            // Act
            resolver.addSession(input);

            // Assert
            expect(sessions).toHaveLength(1);
            expect(sessions[0].tutor).toBe('Alice Brown');
        });

        it('should return the created session', () => {
            // Arrange
            const input: SessionInput = {
                tutor: 'Test Tutor',
                student: 'Test Student',
                date: new Date('2024-01-01'),
                duration: 60,
            };

            // Act
            const result = resolver.addSession(input);

            // Assert
            expect(sessions[0]).toBe(result);
        });

        it('should create multiple sessions', () => {
            // Arrange
            const input1: SessionInput = {
                tutor: 'Tutor One',
                student: 'Student One',
                date: new Date('2024-01-01'),
                duration: 60,
            };
            const input2: SessionInput = {
                tutor: 'Tutor Two',
                student: 'Student Two',
                date: new Date('2024-02-01'),
                duration: 45,
            };

            // Act
            const result1 = resolver.addSession(input1);
            const result2 = resolver.addSession(input2);

            // Assert
            expect(sessions).toHaveLength(2);
            expect(result1.id).toBe('mocked-session-uuid');
            expect(result2.id).toBe('mocked-session-uuid');
        });

        it('should handle optional notes field', () => {
            // Arrange
            const input: SessionInput = {
                tutor: 'Tutor',
                student: 'Student',
                date: new Date('2024-01-01'),
                duration: 60,
            };

            // Act
            const result = resolver.addSession(input);

            // Assert
            expect(result.tutor).toBe('Tutor');
            expect(result.notes).toBeUndefined();
        });
    });
});
