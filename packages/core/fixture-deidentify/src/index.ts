export {
  buildIdentityMap,
  generateFakeIdentity,
  passwordHashForUserId,
} from './identity-map.js';
export { FIRST_NAMES, LAST_NAMES } from './fake-names.js';
export {
  deidentifyMongoPayload,
  deidentifyUserProfiles,
  DEIDENTIFIED_MONGO_COLLECTIONS,
} from './mongo-deidentifier.js';
export type {
  FakeIdentity,
  DeidentifyMap,
  SerializedDeidentifyMap,
  MongoCollectionPayload,
  MongoExtractionPayload,
} from './types.js';
