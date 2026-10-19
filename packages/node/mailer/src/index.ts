export type { MailMessage, MailAdapter, MailLogger } from './types.js';
export {
  CaptureMailAdapter,
  createS3CaptureWriter,
  type CapturedMail,
  type CaptureWriter,
  type CaptureMailAdapterOptions,
  type S3Like,
  type S3CaptureWriterOptions,
} from './capture-adapter.js';
export { MailConfigSchema, loadMailConfig, type MailConfig } from './config.js';
export { StubMailAdapter } from './stub-adapter.js';
export {
  SesMailAdapter,
  type SesLike,
  type SesClientFactory,
  type SesMailAdapterOptions,
} from './ses-adapter.js';
export { MailService } from './mail-service.js';
export { MockMailAdapter } from './mocks/mock-mail-adapter.js';
