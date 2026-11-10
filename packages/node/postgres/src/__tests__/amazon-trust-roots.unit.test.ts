import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { amazonTrustRoots } from '../amazon-trust-roots.js';

describe('amazonTrustRoots', () => {
  const subjects = amazonTrustRoots.map((pem) => new X509Certificate(pem).subject);

  it('holds exactly the Amazon Trust Services roots', () => {
    expect(amazonTrustRoots).toHaveLength(5);
    expect(
      subjects.every((s) =>
        /CN=(Amazon Root CA [1-4]|Starfield Services Root Certificate Authority - G2)$/m.test(s),
      ),
    ).toBe(true);
  });

  it('excludes other public CAs', () => {
    expect(subjects.some((s) => /emSign|eMudhra/i.test(s))).toBe(false);
  });
});
