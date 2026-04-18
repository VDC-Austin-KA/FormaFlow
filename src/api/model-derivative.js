/**
 * Model Derivative Client
 *
 * Uses the official @aps_sdk/model-derivative package to extract model
 * properties (categories, system classifications, family names, etc.) needed
 * for automatic discipline identification.
 *
 * SDK Reference:
 *   https://github.com/autodesk-platform-services/aps-sdk-node/tree/main/modelderivative
 * API Docs:
 *   https://aps.autodesk.com/en/docs/model-derivative/v2/reference/
 */

import { DerivativesApi, ObjectsApi } from '@aps_sdk/model-derivative';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ModelDerivative');

// Property names we care about for discipline classification
const DISCIPLINE_PROPERTIES = [
  'Category',
  'System Classification',
  'System Type',
  'Discipline',
  'Family',
  'Type',
  'Structural Material',
  'Voltage',
  'Phase Created'
];

export class ModelDerivativeClient {
  /**
   * @param {import('./aps-client.js').APSClient} apsClient
   */
  constructor(apsClient) {
    this._client = apsClient;
    this._derivativesApi = new DerivativesApi(apsClient.sdkManager);
  }

  /**
   * Extract discipline-relevant properties from a model by its URN.
   * Returns a ModelDescriptor suitable for DisciplineClassifier.
   *
   * @param {string} urn      - Base64-encoded document URN
   * @param {string} fileName - Original file name (used for pattern matching)
   * @returns {Promise<ModelDescriptor>}
   */
  async extractModelDescriptor(urn, fileName) {
    logger.info('Extracting properties from: %s', fileName);

    try {
      const metadata = await this._getMetadata(urn);
      const guid = metadata?.data?.metadata?.[0]?.guid;
      if (!guid) {
        logger.warn('No viewable GUID found for %s — using filename only', fileName);
        return this._fallbackDescriptor(urn, fileName);
      }

      const props = await this._getProperties(urn, guid);
      return this._buildDescriptor(urn, fileName, props);
    } catch (err) {
      logger.warn('Property extraction failed for %s: %s — using filename only', fileName, err.message);
      return this._fallbackDescriptor(urn, fileName);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  async _getMetadata(urn) {
    return this._derivativesApi.getMetadata(urn, { xAdsForce: false });
  }

  async _getProperties(urn, guid) {
    return this._derivativesApi.getAllProperties(urn, guid, {
      objectid: 1  // root node
    });
  }

  _buildDescriptor(urn, fileName, rawProps) {
    const categories = new Set();
    const systemClassifications = new Set();
    const systemTypes = new Set();
    const propertyBag = {};

    const collection = rawProps?.data?.collection ?? [];
    for (const obj of collection) {
      const props = obj.properties ?? {};
      for (const [groupName, groupProps] of Object.entries(props)) {
        for (const [propName, propValue] of Object.entries(groupProps)) {
          const cleanName = propName.trim();
          const cleanValue = String(propValue).trim();

          if (cleanName === 'Category') categories.add(cleanValue);
          if (cleanName === 'System Classification') systemClassifications.add(cleanValue);
          if (cleanName === 'System Type') systemTypes.add(cleanValue);
          if (DISCIPLINE_PROPERTIES.includes(cleanName)) {
            propertyBag[cleanName] = cleanValue;
          }
        }
      }
    }

    return {
      id: urn,
      urn,
      fileName,
      categories: [...categories],
      systemClassifications: [...systemClassifications],
      systemTypes: [...systemTypes],
      properties: propertyBag
    };
  }

  _fallbackDescriptor(urn, fileName) {
    return {
      id: urn,
      urn,
      fileName,
      categories: [],
      systemClassifications: [],
      systemTypes: [],
      properties: {}
    };
  }
}

/**
 * @typedef {Object} ModelDescriptor
 * @property {string}   id
 * @property {string}   urn
 * @property {string}   fileName
 * @property {string[]} categories
 * @property {string[]} systemClassifications
 * @property {string[]} systemTypes
 * @property {Object}   properties
 */
