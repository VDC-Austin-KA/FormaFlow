/**
 * ACC Issues API Client (Construction v1)
 *
 * Endpoints: https://developer.api.autodesk.com/construction/issues/v1/
 * Docs:      https://aps.autodesk.com/en/docs/acc/v1/reference/http/issues-issues-GET/
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('IssuesClient');

const BASE = 'https://developer.api.autodesk.com/construction/issues/v1';

export class IssuesClient {
  /**
   * @param {import('./aps-client.js').APSClient} apsClient
   * @param {string} projectId  ACC project ID (without "b." prefix; we add it where needed)
   */
  constructor(apsClient, projectId) {
    if (!projectId) throw new Error('IssuesClient requires projectId');
    this._client = apsClient;
    // The Construction Issues API expects the raw GUID — strip any "b." prefix
    this._projectId = projectId.replace(/^b\./, '');
  }

  /**
   * List issues with optional filters.
   * @param {object} opts
   * @param {string[]} [opts.status]       e.g. ['open','closed']
   * @param {string}   [opts.assignedTo]   user/role/company id
   * @param {string[]} [opts.issueTypeId]  filter by type
   * @param {number}   [opts.limit=200]
   * @param {string}   [opts.offset]       cursor for pagination
   */
  async list(opts = {}) {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 200));
    if (opts.status?.length)       qs.set('filter[status]', opts.status.join(','));
    if (opts.assignedTo)           qs.set('filter[assigned_to]', opts.assignedTo);
    if (opts.issueTypeId?.length)  qs.set('filter[issue_type_id]', opts.issueTypeId.join(','));
    if (opts.offset)               qs.set('offset', opts.offset);
    return this._client.get(`${BASE}/projects/${this._projectId}/issues?${qs}`);
  }

  async get(issueId) {
    return this._client.get(`${BASE}/projects/${this._projectId}/issues/${issueId}`);
  }

  async create(issue) {
    logger.info('Creating issue: %s', issue.title);
    return this._client.post(`${BASE}/projects/${this._projectId}/issues`, issue);
  }

  async update(issueId, patch) {
    return this._client.patch(`${BASE}/projects/${this._projectId}/issues/${issueId}`, patch);
  }

  async listTypes() {
    return this._client.get(`${BASE}/projects/${this._projectId}/issue-types?include=subtypes&limit=200`);
  }

  async listRootCauses() {
    return this._client.get(`${BASE}/projects/${this._projectId}/issue-root-cause-categories?include=root_causes&limit=200`);
  }

  async listComments(issueId) {
    return this._client.get(`${BASE}/projects/${this._projectId}/issues/${issueId}/comments`);
  }

  async addComment(issueId, body) {
    return this._client.post(`${BASE}/projects/${this._projectId}/issues/${issueId}/comments`, { body });
  }
}
