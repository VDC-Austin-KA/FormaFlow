/**
 * APS API Client
 *
 * Wraps the official @aps_sdk/authentication package for 2-legged OAuth
 * and exposes a fetch() helper that automatically refreshes the bearer token.
 *
 * References:
 *  - https://github.com/autodesk-platform-services/aps-sdk-node
 *  - https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/overview/
 */

import { SdkManagerBuilder } from '@aps_sdk/autodesk-sdkmanager';
import { AuthenticationClient, Scopes } from '@aps_sdk/authentication';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('APSClient');

const APS_BASE_URL = process.env.APS_BASE_URL ?? 'https://developer.api.autodesk.com';

export class APSClient {
  /**
   * @param {string} clientId   - APS application Client ID
   * @param {string} clientSecret - APS application Client Secret
   */
  constructor(
    clientId = process.env.APS_CLIENT_ID,
    clientSecret = process.env.APS_CLIENT_SECRET
  ) {
    if (!clientId || !clientSecret) {
      throw new Error('APS_CLIENT_ID and APS_CLIENT_SECRET must be set in environment variables');
    }
    this._clientId = clientId;
    this._clientSecret = clientSecret;
    this._tokenCache = null;
    this._tokenExpiry = 0;

    // Build the SDK Manager (shared across all @aps_sdk/* packages)
    this._sdkManager = SdkManagerBuilder.create().build();
    this._authClient = new AuthenticationClient({ sdkManager: this._sdkManager });
  }

  /**
   * Get (or refresh) a 2-legged access token.
   * Scopes cover everything needed for Model Coordination + Model Derivative.
   */
  async getToken() {
    const now = Date.now();
    if (this._tokenCache && now < this._tokenExpiry - 60_000) {
      return this._tokenCache;
    }

    logger.debug('Fetching new 2-legged OAuth token');
    const response = await this._authClient.getTwoLeggedToken(
      this._clientId,
      this._clientSecret,
      [
        Scopes.DataRead,
        Scopes.DataWrite,
        Scopes.DataCreate,
        Scopes.AccountRead
      ]
    );

    this._tokenCache = response.access_token;
    this._tokenExpiry = now + response.expires_in * 1000;
    logger.debug('Token obtained, expires in %ds', response.expires_in);
    return this._tokenCache;
  }

  /**
   * Make an authenticated HTTP request.
   *
   * @param {string} url          - Full URL or path relative to APS_BASE_URL
   * @param {RequestInit} options - fetch options (method, headers, body …)
   * @returns {Promise<any>}      - Parsed JSON response body
   */
  async request(url, options = {}) {
    const token = await this.getToken();
    const fullUrl = url.startsWith('http') ? url : `${APS_BASE_URL}${url}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    };

    const response = await fetch(fullUrl, { ...options, headers });

    if (!response.ok) {
      const body = await response.text();
      throw new APSError(response.status, response.statusText, fullUrl, body);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /** Convenience GET */
  get(url, params = {}) {
    const qs = Object.keys(params).length
      ? `?${new URLSearchParams(params)}`
      : '';
    return this.request(`${url}${qs}`);
  }

  /** Convenience POST */
  post(url, body) {
    return this.request(url, { method: 'POST', body: JSON.stringify(body) });
  }

  /** Convenience PATCH */
  patch(url, body) {
    return this.request(url, { method: 'PATCH', body: JSON.stringify(body) });
  }

  /** Convenience DELETE */
  delete(url) {
    return this.request(url, { method: 'DELETE' });
  }

  /** Expose the SDK manager for @aps_sdk/* module usage */
  get sdkManager() {
    return this._sdkManager;
  }
}

export class APSError extends Error {
  constructor(status, statusText, url, body) {
    super(`APS API ${status} ${statusText} — ${url}`);
    this.name = 'APSError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}
