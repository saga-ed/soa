import Image, { type ImageProps } from 'next/image';
import { Button } from '@saga-ed/soa-ui/button';
import styles from './page.module.css';

type Props = Omit<ImageProps, 'src'> & {
  srcLight: string;
  srcDark: string;
};

const ThemeImage = (props: Props) => {
  const { srcLight, srcDark, ...rest } = props;

  return (
    <>
      <Image {...rest} src={srcLight} className="imgLight" />
      <Image {...rest} src={srcDark} className="imgDark" />
    </>
  );
};

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <ThemeImage
          className={styles.logo}
          srcLight="turborepo-dark.svg"
          srcDark="turborepo-light.svg"
          alt="Turborepo logo"
          width={180}
          height={38}
          priority
        />
        
        <h1 className={styles.title}>Saga SOA Web Client</h1>
        <p className={styles.description}>
          A Next.js web client demonstrating integration with saga-soa API examples.
        </p>

        <div className={styles.content}>
          <h2>Available API Examples</h2>
          <div className={styles.apiGrid}>
            <div className={styles.apiCard}>
              <h3>REST API</h3>
              <p>Express.js based RESTful API with controller architecture</p>
              <a href="/rest-api" className={styles.apiLink}>
                View REST API Example →
              </a>
            </div>
            
            <div className={styles.apiCard}>
              <h3>tRPC API</h3>
              <p>Type-safe API with end-to-end type safety</p>
              <a href="/trpc-api" className={styles.apiLink}>
                View tRPC API Example →
              </a>
            </div>
            
            <div className={styles.apiCard}>
              <h3>TypeGraphQL API</h3>
              <p>TypeGraphQL schema with resolver-based architecture</p>
              <a href="/tgql-api" className={styles.apiLink}>
                View TypeGraphQL API Example →
              </a>
            </div>
          </div>
        </div>

        <div className={styles.ctas}>
          <Button appName="web-client" className={styles.primary}>
            Explore APIs
          </Button>
          <a
            href="https://github.com/your-org/saga-soa"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.secondary}
          >
            View Source Code
          </a>
        </div>
      </main>
      <footer className={styles.footer}>
        <a
          href="https://turborepo.com/docs?utm_source"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image aria-hidden src="/globe.svg" alt="Globe icon" width={16} height={16} />
          Turborepo Docs
        </a>
        <a
          href="https://nextjs.org/docs"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image aria-hidden src="/window.svg" alt="Window icon" width={16} height={16} />
          Next.js Docs
        </a>
      </footer>
    </div>
  );
}
