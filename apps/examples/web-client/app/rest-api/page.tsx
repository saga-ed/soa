'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import styles from '../shared.module.css';

export default function RestApiPage() {
    const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
    const [serverUrl, setServerUrl] = useState('http://localhost:4000');

    useEffect(() => {
        // Check connection status on mount
        checkConnectionStatus();
    }, []);

    const checkConnectionStatus = async () => {
        try {
            setConnectionStatus('connecting');
            const response = await fetch(`${serverUrl}/health`);
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
                        🔷 REST API Example
                    </h1>
                    <p className={styles.subtitle}>
                        Express.js based RESTful API with controller architecture and dependency injection
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
                    <h2 className={styles.sectionTitle}>🛠️ REST API Features</h2>
                    <div className={styles.infoBox}>
                        <p className={styles.infoText}>
                            <strong className={styles.infoTextStrong}>Express.js Architecture:</strong> Traditional RESTful API design with modern TypeScript patterns.
                        </p>
                    </div>
                    <div className={styles.grid}>
                        <div>
                            <h3 className={styles.featureTitle}>Architecture</h3>
                            <ul className={styles.featureList}>
                                <li>Express.js server setup</li>
                                <li>RESTful API design</li>
                                <li>Controller-based architecture</li>
                                <li>Dependency injection with InversifyJS</li>
                                <li>Routing-controllers decorators</li>
                            </ul>
                        </div>
                        <div>
                            <h3 className={styles.featureTitle}>Available Endpoints</h3>
                            <ul className={`${styles.featureList} ${styles.codeList}`}>
                                <li><code>GET /saga-soa/hello/test-route</code></li>
                                <li><code>GET /saga-soa/hello-again/test-route</code></li>
                                <li><code>GET /saga-soa/hello-mongo/test-route</code></li>
                                <li><code>GET /health</code></li>
                                <li><code>GET /saga-soa/sectors/list</code></li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>📋 Key Concepts</h2>
                    <div className={styles.infoBox}>
                        <ul className={styles.conceptList}>
                            <li><strong>Sector-based organization:</strong> Each feature area is a "sector" with its own controller</li>
                            <li><strong>Decorator-driven routing:</strong> @Get, @Post decorators define endpoints</li>
                            <li><strong>Dependency injection:</strong> Automatic resolution of service dependencies</li>
                            <li><strong>Health monitoring:</strong> Built-in health check endpoints</li>
                            <li><strong>Logging integration:</strong> Structured logging via injected logger</li>
                        </ul>
                    </div>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>🔗 Quick Links</h2>
                    <div className={styles.buttonGroup}>
                        <a
                            href={`${serverUrl}/health`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`${styles.button} ${styles.buttonPrimary}`}
                        >
                            Health Check
                        </a>
                        <a
                            href={`${serverUrl}/saga-soa/sectors/list`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`${styles.button} ${styles.buttonSuccess}`}
                        >
                            View Sectors List
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
