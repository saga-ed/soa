import { Button } from '@saga-ed/soa-ui/button';
import Link from 'next/link';
import styles from '../page.module.css';

export default function GraphqlApiPage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.title}>GraphQL API Example</h1>
        <p className={styles.description}>
          This page demonstrates integration with the GraphQL API example from saga-soa.
        </p>
        
        <div className={styles.content}>
          <h2>Available Queries & Mutations</h2>
          <ul>
            <li><code>users</code> - Get all users</li>
            <li><code>user</code> - Get user by ID</li>
            <li><code>createUser</code> - Create new user</li>
            <li><code>sessions</code> - Get all sessions</li>
            <li><code>session</code> - Get session by ID</li>
            <li><code>createSession</code> - Create new session</li>
          </ul>
          
          <p>
            The GraphQL API example demonstrates:
          </p>
          <ul>
            <li>GraphQL schema design</li>
            <li>Resolver-based architecture</li>
            <li>Type-safe queries and mutations</li>
            <li>Apollo Server integration</li>
            <li>GraphQL Playground</li>
          </ul>
        </div>

        <div className={styles.ctas}>
          <Button appName="web-client" className={styles.primary}>
            Test GraphQL Queries
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