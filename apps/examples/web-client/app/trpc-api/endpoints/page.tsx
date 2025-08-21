'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from '../page.module.css';
import { ENDPOINTS } from '../../../src/services/endpoints';
import { TrpcCurlService } from '../../../src/services/trpc-curl-service';
import { TrpcClientService } from '../../../src/services/trpc-client-service';

type EndpointType = typeof ENDPOINTS[0];

export default function TrpcEndpointsPage() {
  const [selectedEndpoint, setSelectedEndpoint] = useState<EndpointType | null>(null);
  const [inputData, setInputData] = useState<string>('');
  const [response, setResponse] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [useTrpcClient, setUseTrpcClient] = useState(false);

  // Initialize services
  const curlService = new TrpcCurlService();
  const trpcService = new TrpcClientService();

  const handleEndpointChange = (endpointId: string) => {
    const endpoint = ENDPOINTS.find(ep => ep.id === endpointId);
    setSelectedEndpoint(endpoint || null);
    setInputData(endpoint?.sampleInput ? JSON.stringify(endpoint.sampleInput, null, 2) : '');
    setResponse('');
    setError('');
  };

  const generateCode = (endpoint: EndpointType, input: string) => {
    const service = useTrpcClient ? trpcService : curlService;
    return service.generateCode(endpoint, input);
  };

  const executeEndpoint = async () => {
    if (!selectedEndpoint) return;

    setIsLoading(true);
    setError('');
    setResponse('');

    try {
      const service = useTrpcClient ? trpcService : curlService;
      const result = await service.executeEndpoint(selectedEndpoint, inputData);
      
      if (result.success) {
        setResponse(JSON.stringify(result.data, null, 2));
      } else {
        setError(result.error || 'An error occurred');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div>
          <h1 className={styles.title}>🧪 tRPC Endpoint Tester</h1>
          <p className={styles.subtitle}>
            Interactive endpoint testing with dropdown selection, code generation, and response inspection
          </p>
        </div>
        
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>🎛️ API Mode</h2>
          <div className={styles.infoBox}>
            <div className={styles.buttonGroup}>
              <label className={styles.checkboxLabel}>
                <input
                  type="radio"
                  name="mode"
                  checked={!useTrpcClient}
                  onChange={() => setUseTrpcClient(false)}
                  className={styles.checkbox}
                />
                cURL Mode
              </label>
              <label className={styles.checkboxLabel}>
                <input
                  type="radio"
                  name="mode"
                  checked={useTrpcClient}
                  onChange={() => setUseTrpcClient(true)}
                  className={styles.checkbox}
                />
                tRPC Client Mode
              </label>
            </div>
            <p className={styles.infoText}>
              <strong className={styles.infoTextStrong}>
                {useTrpcClient ? 'tRPC Client Mode:' : 'cURL Mode:'}
              </strong>{' '}
              {useTrpcClient
                ? 'Using type-safe tRPC client with full TypeScript support'
                : 'Using HTTP requests with curl commands'
              }
            </p>
          </div>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>🔍 Select Endpoint</h2>
          <select
            value={selectedEndpoint?.id || ''}
            onChange={(e) => handleEndpointChange(e.target.value)}
            className={styles.input}
          >
            <option value="">Choose an endpoint...</option>
            {ENDPOINTS.map(endpoint => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.name} ({endpoint.method})
              </option>
            ))}
          </select>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>📋 Endpoint Details</h2>
          {selectedEndpoint ? (
            <div className={styles.responseBox}>
              <h3 className={styles.responseTitle}>Selected Endpoint</h3>
              <div className={styles.responseContent}>
                <div><strong>Name:</strong> {selectedEndpoint.name}</div>
                <div><strong>Method:</strong> {selectedEndpoint.method}</div>
                <div><strong>Description:</strong> {selectedEndpoint.description}</div>
                <div><strong>URL:</strong> <code className={styles.codeBlock}>{selectedEndpoint.url}</code></div>
                {selectedEndpoint.inputType && (
                  <div><strong>Input Type:</strong> <code className={styles.codeBlock}>{selectedEndpoint.inputType}</code></div>
                )}
              </div>
            </div>
          ) : (
            <div className={styles.infoBox}>
              <p className={styles.infoText}>
                <strong className={styles.infoTextStrong}>No endpoint selected:</strong> Choose an endpoint from the dropdown above to see its details, input requirements, and sample data.
              </p>
            </div>
          )}
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>⚙️ Input Data (JSON)</h2>
          <div className={styles.formGroup}>
            <label className={styles.label}>
              {selectedEndpoint ? 'JSON Input Data' : 'Select an endpoint to enable input'}
            </label>
            <textarea
              value={inputData}
              onChange={(e) => setInputData(e.target.value)}
              placeholder={selectedEndpoint ? "Enter JSON input data..." : "Select an endpoint to enable input"}
              disabled={!selectedEndpoint}
              className={styles.input}
              style={{
                minHeight: '120px',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '14px',
                opacity: selectedEndpoint ? 1 : 0.6
              }}
            />
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.connectionStatusRow}>
            <h2 className={styles.sectionTitle}>
              💻 Generated Code ({useTrpcClient ? 'tRPC Client' : 'cURL'})
            </h2>
            {selectedEndpoint && (
              <button
                onClick={() => {
                  const code = generateCode(selectedEndpoint, inputData);
                  navigator.clipboard.writeText(code);
                }}
                className={`${styles.button} ${styles.buttonSecondary}`}
              >
                📋 Copy Code
              </button>
            )}
          </div>
          
          {selectedEndpoint ? (
            <div className={styles.terminalBox}>
              <pre className={styles.codeBlock}>
                {generateCode(selectedEndpoint, inputData)}
              </pre>
            </div>
          ) : (
            <div className={styles.infoBox}>
              <p className={styles.infoText}>
                <strong className={styles.infoTextStrong}>No code generated:</strong> Select an endpoint to see the generated code examples.
              </p>
            </div>
          )}
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>🚀 Execute Endpoint</h2>
          <div className={styles.buttonGroup}>
            <button
              onClick={executeEndpoint}
              disabled={!selectedEndpoint || isLoading}
              className={`${styles.button} ${styles.buttonPrimary}`}
            >
              {isLoading ? '🔄 Executing...' : '▶️ Execute Endpoint'}
            </button>
            <button
              onClick={() => {
                setResponse('');
                setError('');
              }}
              disabled={!selectedEndpoint}
              className={`${styles.button} ${styles.buttonSecondary}`}
            >
              🗑️ Clear Response
            </button>
          </div>
        </div>

        {error && (
          <div className={styles.section}>
            <div className={styles.errorBox}>
              <div className={styles.errorIcon}>
                <svg viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              </div>
              <div className={styles.errorContent}>
                <h3 className={styles.errorTitle}>Execution Error</h3>
                <div className={styles.errorMessage}>{error}</div>
              </div>
            </div>
          </div>
        )}

        {response && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>✅ Response</h2>
            <div className={styles.responseBox}>
              <h3 className={styles.responseTitle}>Endpoint Response</h3>
              <div className={styles.terminalBox}>
                <pre className={styles.codeBlock}>{response}</pre>
              </div>
            </div>
          </div>
        )}

        {!selectedEndpoint && !error && !response && (
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>📊 Response</h2>
            <div className={styles.infoBox}>
              <p className={styles.infoText}>
                <strong className={styles.infoTextStrong}>Ready to test:</strong> Select an endpoint, configure the input data, and click &quot;Execute Endpoint&quot; to see the response here.
              </p>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className={styles.section}>
          <div className={styles.connectionStatusRow}>
            <h2 className={styles.sectionTitle}>🔄 Navigation</h2>
            <div className={styles.connectionControlsRow}>
              <Link
                href="/trpc-api"
                className={`${styles.button} ${styles.buttonSecondary}`}
                style={{ textDecoration: 'none' }}
              >
                ← Back to PubSub Demo
              </Link>
              <Link
                href="/"
                className={`${styles.button} ${styles.buttonSecondary}`}
                style={{ textDecoration: 'none' }}
              >
                🏠 Back to Home
              </Link>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}