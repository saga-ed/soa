'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from '../shared.module.css';

export default function TypeGraphqlApiPage() {
    const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
    const [serverUrl, setServerUrl] = useState('http://localhost:4002');

    useEffect(() => {
        // Check connection status on mount
        checkConnectionStatus();
    }, []);

    const checkConnectionStatus = async () => {
        try {
            setConnectionStatus('connecting');
            const response = await fetch(`${serverUrl}/saga-soa/v1/graphql`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: '{ __typename }'
                })
            });
            if (response.ok) {
                setConnectionStatus('connected');
            } else {
                setConnectionStatus('disconnected');
            }
        } catch (error) {
            setConnectionStatus('disconnected');
        }
    };

    const connectToServer = async () => {
        await checkConnectionStatus();
    };

    const disconnectFromServer = () => {
        setConnectionStatus('disconnected');
    };

    return (
        <div className={styles.page}>
            <div className={styles.container}>
                <div>
                    <h1 className={styles.title}>
                        🟣 GraphQL API (TypeGraphQL Schema)
                    </h1>
                    <p className={styles.subtitle}>
                        Modern code-first GraphQL with TypeScript decorators and automatic type generation
                    </p>
                </div>

                {/* Connection Status */}
                <div className={styles.section}>
                    <div className={styles.connectionStatus}>
                        <div className={styles.connectionStatusRow}>
                            <div className={styles.connectionInfo}>
                                <div className={`${styles.statusIndicator} ${
                                    connectionStatus === 'connected' ? styles.statusConnected :
                                    connectionStatus === 'connecting' ? styles.statusConnecting : styles.statusDisconnected
                                }`} />
                                <span className={styles.statusText}>
                                    📡 Connection Status: {connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}
                                </span>
                            </div>
                            <div className={styles.connectionControls}>
                                <input
                                    type="text"
                                    value={serverUrl}
                                    onChange={(e) => setServerUrl(e.target.value)}
                                    placeholder="Server URL"
                                    className={styles.input}
                                />
                                <div className={styles.connectionControlsRow}>
                                    <button
                                        onClick={connectToServer}
                                        disabled={connectionStatus === 'connected'}
                                        className={`${styles.button} ${styles.buttonPrimary}`}
                                    >
                                        Connect
                                    </button>
                                    <button
                                        onClick={disconnectFromServer}
                                        disabled={connectionStatus === 'disconnected'}
                                        className={`${styles.button} ${styles.buttonDanger}`}
                                    >
                                        Disconnect
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>⚡ Code-First Approach</h2>
                    <div className={styles.infoBox}>
                        <p className={styles.infoText}>
                            <strong className={styles.infoTextStrong}>TypeGraphQL:</strong> Generates GraphQL schemas from TypeScript classes
                            decorated with @ObjectType, @Query, and @Mutation. Automatic type safety between TypeScript and GraphQL.
                        </p>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🔍 Available Operations</h2>
                    <div className={styles.grid}>
                        <div>
                            <h3 className={styles.featureTitle}>User Operations</h3>
                            <ul className={`${styles.featureList} ${styles.codeList}`}>
                                <li><code>allUsers</code> - Get all users</li>
                                <li><code>user(id: ID!)</code> - Get user by ID</li>
                                <li><code>addUser(input: UserInput!)</code> - Create new user</li>
                            </ul>
                        </div>
                        <div>
                            <h3 className={styles.featureTitle}>Session Operations</h3>
                            <ul className={`${styles.featureList} ${styles.codeList}`}>
                                <li><code>allSessions</code> - Get all sessions</li>
                                <li><code>session(id: ID!)</code> - Get session by ID</li>
                                <li><code>createSession(input: SessionInput!)</code> - Create session</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🎨 TypeGraphQL Features</h2>
                    <div className={styles.infoBox}>
                        <ul className={styles.conceptList}>
                            <li><strong>Code-first schema generation</strong> - Write TypeScript, get GraphQL</li>
                            <li><strong>Decorator-driven</strong> - @Query, @Mutation, @Resolver, @Field</li>
                            <li><strong>Automatic type safety</strong> - TypeScript types become GraphQL types</li>
                            <li><strong>Class-based resolvers</strong> - Object-oriented resolver architecture</li>
                            <li><strong>Apollo Server integration</strong> - Full GraphQL ecosystem support</li>
                            <li><strong>Validation support</strong> - Built-in argument validation with class-validator</li>
                        </ul>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🔄 Key Differences from SDL-First</h2>
                    <div className={styles.infoBox}>
                        <ul className={styles.conceptList}>
                            <li>Schema is defined in TypeScript code, not .gql files</li>
                            <li>Uses decorators (@ObjectType, @Field, @Query, @Mutation)</li>
                            <li>Resolvers are class methods with decorators</li>
                            <li>Automatic schema generation from TypeScript types</li>
                            <li>Strongly coupled with TypeScript (not language-agnostic)</li>
                        </ul>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🎨 Example TypeGraphQL Code</h2>
                    <div className={styles.infoBox}>
                        <pre className={styles.codeExample}>
{`@ObjectType()
class User {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  email: string;
}

@Resolver(User)
class UserResolver {
  @Query(() => [User])
  allUsers() {
    return getAllUsers();
  }

  @Mutation(() => User)
  addUser(@Arg("input") input: UserInput) {
    return createUser(input);
  }
}`}
                        </pre>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🔗 Quick Links</h2>
                    <div className={styles.buttonGroup}>
                        <a
                            href={`${serverUrl}/saga-soa/v1/graphql`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`${styles.button} ${styles.buttonPrimary}`}
                        >
                            Open GraphQL Playground
                        </a>
                        <a
                            href={`${serverUrl}/health`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`${styles.button} ${styles.buttonSuccess}`}
                        >
                            Health Check
                        </a>
                        <Link
                            href="/"
                            className={`${styles.button} ${styles.buttonSecondary}`}
                        >
                            ← Back to Home
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
