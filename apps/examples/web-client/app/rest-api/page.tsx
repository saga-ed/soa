import { Button } from '@hipponot/soa-ui/button';
import Link from 'next/link';
import styles from '../page.module.css';

export default function RestApiPage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.title}>REST API Example</h1>
        <p className={styles.description}>
          This page demonstrates integration with the REST API example from saga-soa.
        </p>

        <div className={styles.content}>
          <h2>Available Endpoints</h2>
          <ul>
            <li><code>GET /saga-soa/hello/test-route</code> - Hello REST endpoint</li>
            <li><code>GET /saga-soa/hello-again/test-route</code> - Hello Again REST endpoint</li>
            <li><code>GET /saga-soa/hello-mongo/test-route</code> - Hello Mongo REST endpoint</li>
            <li><code>GET /health</code> - Health check endpoint</li>
          </ul>

          <p>
            The REST API example demonstrates:
          </p>
          <ul>
            <li>Express.js server setup</li>
            <li>RESTful API design</li>
            <li>Controller-based architecture</li>
            <li>Dependency injection with InversifyJS</li>
          </ul>
        </div>

        <div className={styles.ctas}>
          <Button appName="web-client" className={styles.primary}>
            Test REST Endpoints
          </Button>
          <Link
            href="/"
            className={styles.secondary}
          >
            Back to Home
          </Link>
        </div>
      </main>
    </div>
  );
} 