import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import { TGQLServer } from '@saga-ed/soa-api-core/tgql-server';
import { container } from '../inversify.config.js';
import { UserResolver } from '../sectors/user/gql/user.resolver.js';
import { SessionResolver } from '../sectors/session/gql/session.resolver.js';
import { users } from '../sectors/user/gql/user.data.js';
import { sessions } from '../sectors/session/gql/session.data.js';

let app: express.Application;

beforeAll(async () => {
    // Arrange: Override TGQLServerConfig to disable schema emission in tests
    const testGqlConfig = container.get('TGQLServerConfig');
    container.rebind('TGQLServerConfig').toConstantValue({
        ...testGqlConfig,
        emitSchema: false, // Disable schema emission to avoid GraphQL module conflicts
    });

    // Initialize ExpressServer first
    const expressServer = container.get(ExpressServer);
    await expressServer.init(container, []);
    app = expressServer.getApp();

    // Add express.json() middleware before Apollo middleware
    app.use(express.json());

    // Statically import resolvers (per testing.md guidelines)
    const gqlResolvers = [UserResolver, SessionResolver];

    // Initialize TGQLServer and mount to app
    const gqlServer = container.get<TGQLServer>(TGQLServer);
    await gqlServer.init(container, gqlResolvers);
    gqlServer.mountToApp(app, '/saga-soa/v1');
});

beforeEach(() => {
    // Arrange: Clear data before each test
    users.length = 0;
    sessions.length = 0;
});

describe('GraphQL API Integration', () => {
    describe('User Queries', () => {
        it('should return empty array for allUsers when no users exist', async () => {
            // Arrange
            const query = `
                query {
                    allUsers {
                        id
                        name
                        email
                        role
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.allUsers).toEqual([]);
        });

        it('should create user via addUser mutation', async () => {
            // Arrange
            const mutation = `
                mutation {
                    addUser(input: {
                        name: "John Doe"
                        email: "john@example.com"
                        role: "admin"
                    }) {
                        id
                        name
                        email
                        role
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query: mutation })
                .expect(200);

            // Assert
            expect(res.body.data.addUser).toMatchObject({
                name: 'John Doe',
                email: 'john@example.com',
                role: 'admin',
            });
            expect(res.body.data.addUser.id).toBeDefined();
        });

        it('should retrieve user by id', async () => {
            // Arrange: Create a user first
            const createMutation = `
                mutation {
                    addUser(input: {
                        name: "Jane Smith"
                        email: "jane@example.com"
                    }) {
                        id
                    }
                }
            `;
            const createRes = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query: createMutation });
            const userId = createRes.body.data.addUser.id;

            const query = `
                query {
                    user(id: "${userId}") {
                        id
                        name
                        email
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.user).toMatchObject({
                id: userId,
                name: 'Jane Smith',
                email: 'jane@example.com',
            });
        });

        it('should return null for non-existent user', async () => {
            // Arrange
            const query = `
                query {
                    user(id: "nonexistent-id") {
                        id
                        name
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.user).toBeNull();
        });

        it('should list all users after creating multiple', async () => {
            // Arrange: Create multiple users
            const mutation1 = `
                mutation {
                    addUser(input: {
                        name: "User One"
                        email: "user1@example.com"
                    }) { id }
                }
            `;
            const mutation2 = `
                mutation {
                    addUser(input: {
                        name: "User Two"
                        email: "user2@example.com"
                    }) { id }
                }
            `;
            await request(app).post('/saga-soa/v1/graphql').send({ query: mutation1 });
            await request(app).post('/saga-soa/v1/graphql').send({ query: mutation2 });

            const query = `
                query {
                    allUsers {
                        name
                        email
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.allUsers).toHaveLength(2);
            expect(res.body.data.allUsers).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'User One', email: 'user1@example.com' }),
                    expect.objectContaining({ name: 'User Two', email: 'user2@example.com' }),
                ])
            );
        });
    });

    describe('Session Queries', () => {
        it('should return empty array for allSessions when no sessions exist', async () => {
            // Arrange
            const query = `
                query {
                    allSessions {
                        id
                        tutor
                        student
                        duration
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.allSessions).toEqual([]);
        });

        it('should create session via addSession mutation', async () => {
            // Arrange
            const mutation = `
                mutation {
                    addSession(input: {
                        tutor: "John Tutor"
                        student: "Jane Student"
                        date: "2024-01-15T10:00:00Z"
                        duration: 60
                        notes: "Good progress"
                    }) {
                        id
                        tutor
                        student
                        duration
                        notes
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query: mutation })
                .expect(200);

            // Assert
            expect(res.body.data.addSession).toMatchObject({
                tutor: 'John Tutor',
                student: 'Jane Student',
                duration: 60,
                notes: 'Good progress',
            });
            expect(res.body.data.addSession.id).toBeDefined();
        });

        it('should retrieve session by id', async () => {
            // Arrange: Create a session first
            const createMutation = `
                mutation {
                    addSession(input: {
                        tutor: "Alice Tutor"
                        student: "Bob Student"
                        date: "2024-02-01T14:00:00Z"
                        duration: 90
                    }) {
                        id
                    }
                }
            `;
            const createRes = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query: createMutation });
            const sessionId = createRes.body.data.addSession.id;

            const query = `
                query {
                    session(id: "${sessionId}") {
                        id
                        tutor
                        student
                        duration
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.session).toMatchObject({
                id: sessionId,
                tutor: 'Alice Tutor',
                student: 'Bob Student',
                duration: 90,
            });
        });

        it('should return null for non-existent session', async () => {
            // Arrange
            const query = `
                query {
                    session(id: "nonexistent-id") {
                        id
                        tutor
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.session).toBeNull();
        });

        it('should list all sessions after creating multiple', async () => {
            // Arrange: Create multiple sessions
            const mutation1 = `
                mutation {
                    addSession(input: {
                        tutor: "Tutor One"
                        student: "Student One"
                        date: "2024-01-01T10:00:00Z"
                        duration: 60
                    }) { id }
                }
            `;
            const mutation2 = `
                mutation {
                    addSession(input: {
                        tutor: "Tutor Two"
                        student: "Student Two"
                        date: "2024-02-01T14:00:00Z"
                        duration: 45
                    }) { id }
                }
            `;
            await request(app).post('/saga-soa/v1/graphql').send({ query: mutation1 });
            await request(app).post('/saga-soa/v1/graphql').send({ query: mutation2 });

            const query = `
                query {
                    allSessions {
                        tutor
                        student
                        duration
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query })
                .expect(200);

            // Assert
            expect(res.body.data.allSessions).toHaveLength(2);
            expect(res.body.data.allSessions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ tutor: 'Tutor One', student: 'Student One', duration: 60 }),
                    expect.objectContaining({ tutor: 'Tutor Two', student: 'Student Two', duration: 45 }),
                ])
            );
        });
    });

    describe('Error Handling', () => {
        it('should return error for invalid GraphQL syntax', async () => {
            // Arrange
            const invalidQuery = `
                query {
                    allUsers {
                        id
                        name
                        invalidField
                    }
                }
            `;

            // Act
            const res = await request(app)
                .post('/saga-soa/v1/graphql')
                .send({ query: invalidQuery });

            // Assert
            expect(res.body.errors).toBeDefined();
            expect(res.body.errors.length).toBeGreaterThan(0);
        });
    });
});
