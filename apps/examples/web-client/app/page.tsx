'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from './shared.module.css';

interface ApiStatus {
    name: string;
    url: string;
    path: string;
    status: 'disconnected' | 'connecting' | 'connected';
    healthEndpoint: string;
}

export default function Home() {
    const [apis, setApis] = useState<ApiStatus[]>([
        {
            name: 'REST API',
            url: 'http://localhost:4000',
            path: '/rest-api',
            status: 'disconnected',
            healthEndpoint: '/health'
        },
        {
            name: 'GraphQL API (SDL Schema)',
            url: 'http://localhost:4001',
            path: '/gql-api',
            status: 'disconnected',
            healthEndpoint: '/health'
        },
        {
            name: 'GraphQL API (TypeGraphQL Schema)',
            url: 'http://localhost:4002',
            path: '/tgql-api',
            status: 'disconnected',
            healthEndpoint: '/health'
        },
        {
            name: 'tRPC API',
            url: 'http://localhost:4003',
            path: '/trpc-api',
            status: 'disconnected',
            healthEndpoint: '/health'
        }
    ]);

    useEffect(() => {
        checkAllConnections();
        // Set up periodic checks every 30 seconds
        const interval = setInterval(checkAllConnections, 30000);
        return () => clearInterval(interval);
    }, []);

    const checkAllConnections = async () => {
        const updatedApis = await Promise.all(
            apis.map(async (api) => {
                try {
                    const response = await fetch(`${api.url}${api.healthEndpoint}`, {
                        method: 'GET',
                        signal: AbortSignal.timeout(5000)
                    });
                    return {
                        ...api,
                        status: response.ok ? 'connected' as const : 'disconnected' as const
                    };
                } catch (error) {
                    return {
                        ...api,
                        status: 'disconnected' as const
                    };
                }
            })
        );
        setApis(updatedApis);
    };

    const refreshConnection = async (index: number) => {
        const api = apis[index];
        if (!api) return;

        setApis(prev => prev.map((a, i) => i === index ? { ...a, status: 'connecting' } : a));

        try {
            const response = await fetch(`${api.url}${api.healthEndpoint}`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });
            setApis(prev => prev.map((a, i) =>
                i === index ? { ...a, status: response.ok ? 'connected' : 'disconnected' } : a
            ));
        } catch (error) {
            setApis(prev => prev.map((a, i) =>
                i === index ? { ...a, status: 'disconnected' } : a
            ));
        }
    };

    return (
        <div className={styles.page}>
            <div className={styles.container}>
                <div>
                    <h1 className={styles.title}>
                        🎯 Saga SOA Web Client
                    </h1>
                    <p className={styles.subtitle}>
                        Comprehensive testing interface for all saga-soa API examples
                    </p>
                </div>

                {/* API Connection Status */}
                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>📡 API Connection Status</h2>
                    <div className={styles.infoBox}>
                        <p className={styles.infoText}>
                            <strong className={styles.infoTextStrong}>Real-time monitoring:</strong> Connection status for all running APIs.
                            Click refresh to check individual API availability.
                        </p>
                    </div>

                    <div className={styles.grid}>
                        {apis.map((api, index) => (
                            <div key={api.name} className={styles.section}>
                                <div className={styles.connectionStatusRow}>
                                    <div className={styles.connectionInfo}>
                                        <div className={`${styles.statusIndicator} ${
                                            api.status === 'connected' ? styles.statusConnected :
                                            api.status === 'connecting' ? styles.statusConnecting :
                                            styles.statusDisconnected
                                        }`} />
                                        <div>
                                            <div className={styles.statusText}>{api.name}</div>
                                            <div style={{
                                                fontSize: '12px',
                                                color: 'var(--gray-alpha-200)'
                                            }} className={styles.urlText}>
                                                {api.url}
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => refreshConnection(index)}
                                        disabled={api.status === 'connecting'}
                                        className={`${styles.button} ${styles.buttonSecondary}`}
                                        style={{ padding: '8px 16px', fontSize: '12px' }}
                                    >
                                        🔄 Refresh
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* API Links */}
                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🚀 Available API Examples</h2>
                    <div className={styles.infoBox}>
                        <p className={styles.infoText}>
                            Explore different API architectures and patterns. Each example demonstrates a unique approach to building modern APIs.
                        </p>
                    </div>

                    <div className={styles.grid}>
                        <Link href="/rest-api" style={{ textDecoration: 'none' }}>
                            <div className={`${styles.section} ${styles.statCardBlue} ${styles.clickableCard}`}>
                                <h3 className={`${styles.sectionTitle} ${styles.cardTitle}`}>
                                    🔷 REST API
                                </h3>
                                <p className={styles.cardDescription}>
                                    Express.js based RESTful API with controller architecture and dependency injection
                                </p>
                            </div>
                        </Link>

                        <Link href="/gql-api" style={{ textDecoration: 'none' }}>
                            <div className={`${styles.section} ${styles.statCardGreen} ${styles.clickableCard}`}>
                                <h3 className={`${styles.sectionTitle} ${styles.cardTitle}`}>
                                    🟢 GraphQL API (SDL Schema)
                                </h3>
                                <p className={styles.cardDescription}>
                                    Schema-first GraphQL with .gql files and resolver objects
                                </p>
                            </div>
                        </Link>

                        <Link href="/tgql-api" style={{ textDecoration: 'none' }}>
                            <div className={`${styles.section} ${styles.statCardPurple} ${styles.clickableCard}`}>
                                <h3 className={`${styles.sectionTitle} ${styles.cardTitle}`}>
                                    🟣 GraphQL API (TypeGraphQL Schema)
                                </h3>
                                <p className={styles.cardDescription}>
                                    Code-first GraphQL with TypeScript decorators and automatic type generation
                                </p>
                            </div>
                        </Link>

                        <Link href="/trpc-api" style={{ textDecoration: 'none' }}>
                            <div className={`${styles.section} ${styles.statCardYellow} ${styles.clickableCard}`}>
                                <h3 className={`${styles.sectionTitle} ${styles.cardTitle}`}>
                                    🟡 tRPC API
                                </h3>
                                <p className={styles.cardDescription}>
                                    Type-safe API with end-to-end TypeScript type inference and PubSub support
                                </p>
                            </div>
                        </Link>
                    </div>
                </div>

                {/* Quick Stats */}
                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>📊 Quick Stats</h2>
                    <div className={styles.statsGrid}>
                        <div className={`${styles.statCard} ${styles.statCardBlue}`}>
                            <div className={`${styles.statValue} ${styles.statValueBlue}`}>
                                {apis.filter(a => a.status === 'connected').length}
                            </div>
                            <div className={`${styles.statLabel} ${styles.statLabelBlue}`}>APIs Online</div>
                        </div>
                        <div className={`${styles.statCard} ${styles.statCardGreen}`}>
                            <div className={`${styles.statValue} ${styles.statValueGreen}`}>4</div>
                            <div className={`${styles.statLabel} ${styles.statLabelGreen}`}>Total APIs</div>
                        </div>
                        <div className={`${styles.statCard} ${styles.statCardPurple}`}>
                            <div className={`${styles.statValue} ${styles.statValuePurple}`}>
                                {apis.filter(a => a.status === 'disconnected').length}
                            </div>
                            <div className={`${styles.statLabel} ${styles.statLabelPurple}`}>Offline</div>
                        </div>
                        <div className={`${styles.statCard} ${styles.statCardEmerald}`}>
                            <div className={`${styles.statValue} ${styles.statValueEmerald}`}>
                                {Math.round((apis.filter(a => a.status === 'connected').length / apis.length) * 100)}%
                            </div>
                            <div className={`${styles.statLabel} ${styles.statLabelEmerald}`}>Health</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
