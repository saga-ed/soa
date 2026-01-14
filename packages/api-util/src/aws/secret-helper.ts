import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { inject, injectable } from 'inversify';
import YAML from 'yaml';
import type { ILogger } from '@saga-ed/soa-logger';
import { ensureError } from '../utils/error-util.js';

export const AWS_REGION = 'us-west-2';

@injectable()
export class SecretHelper {

  private credentials_dir: string;
  private client: SecretsManagerClient;
  public constructor(
    @inject('ILogger') private readonly logger: ILogger
  ) {
    this.credentials_dir = `${homedir()}/credentials`;
    this.client = new SecretsManagerClient({ region: AWS_REGION });
  }

  /**
   * Validates AWS credentials early in startup. This will cause startup to fail
   * immediately if AWS SSO credentials are invalid, preventing the error from
   * flying by unnoticed during normal operation.
   */
  public async validate_aws_credentials(): Promise<void> {
    try {
      const sts_client = new STSClient({ region: AWS_REGION });
      const command = new GetCallerIdentityCommand({});
      await sts_client.send(command);
      this.logger.info('AWS credentials validation successful');
    } catch (err) {
      const error = ensureError(err);

      // Check for the specific SSO session error
      if (error.message.includes('CredentialsProviderError') &&
          error.message.includes('SSO session associated with this profile is invalid')) {
        this.logger.error('AWS SSO SESSION INVALID - Please run: aws sso login');
        this.logger.error('Full error:', error);
        throw new Error('AWS SSO session invalid. Run "aws sso login" to refresh credentials.');
      }

      // Check for other credential-related errors
      if (error.name === 'CredentialsProviderError' ||
        error.message.includes('Unable to locate credentials')) {
        this.logger.error('AWS CREDENTIALS ERROR:', error);
        throw new Error(`AWS credentials validation failed: ${error.message}`);
      }

      // Re-throw other errors
      throw error;
    }
  }

  public get_secret = async (secret_name: string): Promise<string | undefined> => {
    try {
      // try to retrieve from local credentials dir
      const secret_path = `${this.credentials_dir}/${secret_name}`;
      const secret_data = readFileSync(secret_path, 'utf8');
      return secret_data;
    } catch (err) {
      const error = ensureError(err);
      this.logger.debug(`Failed to get secret ${secret_name} from local credentials dir`, error);
    }

    try {
      const command = new GetSecretValueCommand({ SecretId: secret_name });
      const response = await this.client.send(command);
      return response.SecretString;
    } catch (err) {
      const error = ensureError(err);
      this.logger.error(`Failed to get secret ${secret_name}`, error);
      return undefined;
    }
  };

  public get_secret_json = async<T = any>(secret_name: string): Promise<T> => {
    const secret_data = await this.get_secret(secret_name);
    return JSON.parse(secret_data ?? '{}') as T;
  };

  public get_secret_yaml = async<T = any>(secret_name: string): Promise<T> => {
    const secret_data = await this.get_secret(secret_name);
    return YAML.parse(secret_data ?? '{}') as T;
  };
}