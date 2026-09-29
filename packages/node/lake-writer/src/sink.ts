// Where landed data actually goes. `S3LandingSink` talks to the real SDS
// lake buckets; `LocalLandingSink` writes to a local directory for dev,
// preview, and tests where the prod lake is unreachable (or shouldn't be
// touched).

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Upload } from '@aws-sdk/lib-storage';

import { ANALYTICS_BUCKET, DEFAULT_REGION, PII_BUCKET } from './landing-path.js';

export interface PutCuratedArgs {
  key: string;
  /** Local path to the already-written Parquet file. */
  filePath: string;
  metadata: Record<string, string>;
}

export interface PutRawArgs {
  key: string;
  body: Buffer | string;
  metadata: Record<string, string>;
}

export interface PutManifestArgs {
  key: string;
  body: object;
}

export interface LandingSink {
  /** Upload a curated Parquet file to the analytics landing zone. */
  putCurated(args: PutCuratedArgs): Promise<void>;
  /** Upload raw (un-pseudonymised) evidence to the PII bucket. */
  putRaw(args: PutRawArgs): Promise<void>;
  /** Write a run manifest describing what a `runSnapshotExport` call produced. */
  putManifest(args: PutManifestArgs): Promise<void>;
}

/** Resolve a KMS key ARN published at an SSM parameter path. */
export async function resolveKmsKeyArn(
  ssmPath: string,
  opts: { region?: string; ssm?: SSMClient } = {}
): Promise<string> {
  const ssm = opts.ssm ?? new SSMClient({ region: opts.region ?? DEFAULT_REGION });
  const out = await ssm.send(new GetParameterCommand({ Name: ssmPath }));
  const value = out.Parameter?.Value;
  if (!value) {
    throw new Error(`resolveKmsKeyArn: SSM parameter "${ssmPath}" is empty`);
  }
  return value;
}

export interface S3LandingSinkOptions {
  region?: string;
  analyticsBucket?: string;
  piiBucket?: string;
  /** Required — every curated/manifest write is SSE-KMS with this key. */
  analyticsKmsKeyArn: string;
  /** Required to call `putRaw`; omit only when this sink will never write raw evidence. */
  piiKmsKeyArn?: string;
  s3?: S3Client;
}

/**
 * The real lake: uploads curated Parquet to `saga-sds-analytics-prod`
 * and raw evidence to `saga-sds-pii-prod`, both SSE-KMS-encrypted under
 * the CMKs resolved via `resolveKmsKeyArn` / the two `*_KMS_SSM_PATH`
 * constants in landing-path.ts.
 */
export class S3LandingSink implements LandingSink {
  private readonly s3: S3Client;
  private readonly analyticsBucket: string;
  private readonly piiBucket: string;
  private readonly analyticsKmsKeyArn: string;
  private readonly piiKmsKeyArn: string | undefined;

  constructor(opts: S3LandingSinkOptions) {
    this.s3 = opts.s3 ?? new S3Client({ region: opts.region ?? DEFAULT_REGION });
    this.analyticsBucket = opts.analyticsBucket ?? ANALYTICS_BUCKET;
    this.piiBucket = opts.piiBucket ?? PII_BUCKET;
    this.analyticsKmsKeyArn = opts.analyticsKmsKeyArn;
    this.piiKmsKeyArn = opts.piiKmsKeyArn;
  }

  async putCurated(args: PutCuratedArgs): Promise<void> {
    const size = (await stat(args.filePath)).size;
    // Curated Parquet files can be large; multipart via lib-storage keeps
    // memory bounded. The analytics-bucket writer role has Encrypt AND
    // Decrypt on the analytics CMK, so multipart's part-reassembly works.
    await new Upload({
      client: this.s3,
      partSize: 64 * 1024 * 1024,
      params: {
        Bucket: this.analyticsBucket,
        Key: args.key,
        Body: createReadStream(args.filePath),
        ContentLength: size,
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.analyticsKmsKeyArn,
        Metadata: args.metadata,
      },
    }).done();
  }

  async putRaw(args: PutRawArgs): Promise<void> {
    if (!this.piiKmsKeyArn) {
      throw new Error('S3LandingSink.putRaw: piiKmsKeyArn was not configured on this sink');
    }
    // SINGLE PutObjectCommand only — NEVER multipart for the PII bucket.
    // SdsAnalyticsWriter (the role every ingester CLI/lib caller runs as)
    // can write the PII bucket but has NO kms:Decrypt on the PII CMK by
    // design (asymmetric write/read separation — see
    // infra/sds-secure-analytics/CLAUDE.md's "IAM tiers" section). A
    // multipart upload's CompleteMultipartUpload needs Decrypt to
    // reassemble the SSE-KMS-encrypted parts; a single PutObjectCommand
    // needs only Encrypt, which the writer role does have. Caller-side
    // chunking (multiple single-PUT parts under S3's 5 GB PUT cap) is the
    // supported way to land a raw evidence file too large for one PUT —
    // never switch this to Upload.
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.piiBucket,
        Key: args.key,
        Body: args.body,
        ContentType: 'application/octet-stream',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.piiKmsKeyArn,
        Metadata: args.metadata,
      })
    );
  }

  async putManifest(args: PutManifestArgs): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.analyticsBucket,
        Key: args.key,
        Body: JSON.stringify(args.body, null, 2),
        ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.analyticsKmsKeyArn,
      })
    );
  }
}

/**
 * Dev/preview/test sink: writes every object under `<rootDir>/<key>`
 * (creating directories as needed), with metadata written alongside as
 * `<key>.meta.json`. Use this whenever the prod lake buckets are
 * unreachable or shouldn't be touched (local dev, PR previews, unit and
 * integration tests).
 */
export class LocalLandingSink implements LandingSink {
  constructor(private readonly rootDir: string) {}

  private async writeWithMeta(
    key: string,
    data: Buffer | string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const filePath = join(this.rootDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    if (metadata) {
      await writeFile(`${filePath}.meta.json`, JSON.stringify(metadata, null, 2));
    }
  }

  async putCurated(args: PutCuratedArgs): Promise<void> {
    const data = await readFile(args.filePath);
    await this.writeWithMeta(args.key, data, args.metadata);
  }

  async putRaw(args: PutRawArgs): Promise<void> {
    await this.writeWithMeta(args.key, args.body, args.metadata);
  }

  async putManifest(args: PutManifestArgs): Promise<void> {
    await this.writeWithMeta(args.key, JSON.stringify(args.body, null, 2));
  }
}
