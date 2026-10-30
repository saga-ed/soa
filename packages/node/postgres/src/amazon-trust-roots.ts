import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';

// Same pin as student-data-system ledger-db/transcripts-api amazon-trust-roots.ts; keep in sync.
const AMAZON_TRUST_ROOT_CNS = new Set([
  'Amazon Root CA 1',
  'Amazon Root CA 2',
  'Amazon Root CA 3',
  'Amazon Root CA 4',
  'Starfield Services Root Certificate Authority - G2',
]);

function commonName(pem: string): string | undefined {
  return new X509Certificate(pem).subject
    .split('\n')
    .find((part) => part.startsWith('CN='))
    ?.slice(3);
}

export const amazonTrustRoots: readonly string[] = rootCertificates.filter((pem) => {
  const cn = commonName(pem);
  return cn !== undefined && AMAZON_TRUST_ROOT_CNS.has(cn);
});
