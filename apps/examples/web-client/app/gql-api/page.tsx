'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from '../shared.module.css';

export default function GraphqlSdlApiPage() {
    const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
    const [serverUrl, setServerUrl] = useState('http://localhost:4001');

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
                        🟢 GraphQL API (SDL Schema)
                    </h1>
                    <p className={styles.subtitle}>
                        Traditional schema-first GraphQL with .gql files and resolver objects
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
                    <h2 className={styles.sectionTitle}>📖 Schema-First Approach</h2>
                    <div className={styles.infoBox}>
                        <p className={styles.infoText}>
                            <strong className={styles.infoTextStrong}>SDL (Schema Definition Language):</strong> Define GraphQL schemas in .gql files,
                            separate from implementation. Resolvers are plain objects that implement the schema operations.
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
                    <h2 className={styles.sectionTitle}>📁 Schema Files</h2>
                    <div className={styles.infoBox}>
                        <p className={styles.infoText}>
                            Schema defined in <code>schemas/*.gql</code> files:
                        </p>
                        <ul className={styles.schemaFileList}>
                            <li><code>schemas/user.gql</code> - User type, queries, and mutations</li>
                            <li><code>schemas/session.gql</code> - Session type, queries, and mutations</li>
                        </ul>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🎨 Example SDL Schema</h2>
                    <div className={styles.infoBox}>
                        <pre className={styles.codeExample}>
{`type User {
  id: ID!
  name: String!
  email: String!
}

type Query {
  allUsers: [User!]!
  user(id: ID!): User
}

type Mutation {
  addUser(input: UserInput!): User!
}`}
                        </pre>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🔄 Key Differences from Code-First</h2>
                    <div className={styles.infoBox}>
                        <ul className={styles.conceptList}>
                            <li>Schema defined in separate .gql files, not TypeScript code</li>
                            <li>No decorators - uses plain resolver objects</li>
                            <li>Schema and implementation are decoupled</li>
                            <li>Traditional GraphQL approach, language-agnostic</li>
                            <li>Resolvers: <code>(parent, args, context, info) =&gt; result</code></li>
                        </ul>
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
