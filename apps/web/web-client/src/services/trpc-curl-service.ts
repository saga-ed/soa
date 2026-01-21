import type { Endpoint, ApiResponse, ServiceInterface } from './types';

export class TrpcCurlService implements ServiceInterface {
  private baseUrl = 'http://localhost:5000';

  async executeEndpoint(endpoint: Endpoint, input: string): Promise<ApiResponse> {
    try {
      const fullUrl = `${this.baseUrl}${endpoint.url}`;
      
      let response;
      if (endpoint.method === 'GET') {
        const url = input.trim()
          ? `${fullUrl}?input=${encodeURIComponent(input)}`
          : fullUrl;
        response = await fetch(url);
      } else {
        response = await fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: input,
        });
      }

      const data = await response.json();
      
      if (!response.ok) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}: ${response.statusText}`
        };
      }

      return {
        success: true,
        data
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'An error occurred'
      };
    }
  }

  generateCode(endpoint: Endpoint, input: string): string {
    const fullUrl = `${this.baseUrl}${endpoint.url}`;
    
    if (endpoint.method === 'GET') {
      if (input.trim()) {
        const inputParam = encodeURIComponent(input);
        return `curl -X GET "${fullUrl}?input=${inputParam}"`;
      }
      return `curl -X GET "${fullUrl}"`;
    } else {
      return `curl -X POST "${fullUrl}" \\
  -H "Content-Type: application/json" \\
  -d '${input}'`;
    }
  }

  // Return plain text for syntax highlighting to be handled by the UI
  syntaxHighlight(code: string): string {
    return code;
  }
} 