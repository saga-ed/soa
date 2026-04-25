/**
 * In-place de-identification of mongo extraction payload documents.
 *
 * Per D3.6 Phase A spike: real PII lives in `iam_user_profiles.screen_name`,
 * not `userpii` (which is empty in prod-mirror). This module de-identifies
 * iam_user_profiles + defensively scrubs PII surfaces in iam_orgs,
 * saga_learn_sessions titles/notes.
 *
 * Mutates the payload in place — there is one pass before serialization and
 * cloning ~30k documents is wasteful.
 */

import type {
  DeidentifyMap,
  MongoCollectionPayload,
  MongoExtractionPayload,
} from './types.js';

export function deidentifyMongoPayload(
  payload: MongoExtractionPayload,
  map: DeidentifyMap,
): void {
  for (const coll of payload.collections) {
    switch (coll.collection) {
      case 'iam_user_profiles':
        transformIamUserProfiles(coll, map);
        break;
      case 'iam_orgs':
        transformIamOrgs(coll, map);
        break;
      case 'saga_learn_sessions':
        transformSagaLearnSessions(coll, map);
        break;
      default:
        break;
    }
  }
}

/**
 * Convenience: given an array of iam_user_profiles documents, return a new
 * DeidentifyMap keyed off the user_ids present. Used by callers who only
 * need to walk iam_user_profiles without owning the full ExtractionPayload.
 */
export function deidentifyUserProfiles(
  profiles: Array<Record<string, unknown>>,
  map: DeidentifyMap,
): void {
  transformIamUserProfiles(
    { db: 'saga_db', collection: 'iam_user_profiles', documents: profiles },
    map,
  );
}

function transformIamUserProfiles(
  coll: MongoCollectionPayload,
  map: DeidentifyMap,
): void {
  for (const doc of coll.documents) {
    const user_id = doc['user_id'];
    if (typeof user_id !== 'string') continue;
    const identity = map.by_user_id.get(user_id);

    if (identity) {
      if ('screen_name' in doc) doc['screen_name'] = identity.screen_name;
      if ('email' in doc) doc['email'] = identity.email;
      if ('first_name' in doc) doc['first_name'] = identity.first_name;
      if ('last_name' in doc) doc['last_name'] = identity.last_name;
      if ('username' in doc) doc['username'] = identity.screen_name;
      if ('display_name' in doc) doc['display_name'] = identity.screen_name;
    } else {
      if ('screen_name' in doc) doc['screen_name'] = `User ${maskUserId(user_id)}`;
      if ('email' in doc) doc['email'] = `user_${user_id}@fixture.test`;
      if ('first_name' in doc) doc['first_name'] = 'User';
      if ('last_name' in doc) doc['last_name'] = maskUserId(user_id);
      if ('username' in doc) doc['username'] = `User ${maskUserId(user_id)}`;
      if ('display_name' in doc) doc['display_name'] = `User ${maskUserId(user_id)}`;
    }

    const upm = doc['user_provided_metadata'];
    if (Array.isArray(upm)) {
      for (const entry of upm) {
        if (entry === null || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const key = e['key'];
        if (typeof key !== 'string') continue;

        if (key === 'IAM_USER_ID_LABEL') {
          e['value'] = `external_${user_id}`;
        } else if (key === 'IAM_STUDENT_MATH_TEACHER') {
          e['value'] = identity ? identity.last_name : 'Tutor';
        } else if (
          key === 'IAM_STUDENT_PARENT_NAME' ||
          key === 'IAM_STUDENT_PARENT_EMAIL'
        ) {
          e['value'] = identity ? identity.screen_name : 'Guardian';
        } else if (key === 'IAM_STUDENT_PHONE') {
          e['value'] = '';
        }
      }
    }
  }
}

function transformIamOrgs(coll: MongoCollectionPayload, map: DeidentifyMap): void {
  for (const doc of coll.documents) {
    const users = doc['users'];
    if (!Array.isArray(users)) continue;

    for (const u of users) {
      if (u === null || typeof u !== 'object') continue;
      const ru = u as Record<string, unknown>;
      const user_id = ru['user_id'];
      if (typeof user_id !== 'string') continue;
      const identity = map.by_user_id.get(user_id);
      if (!identity) continue;

      if ('display_name' in ru) ru['display_name'] = identity.screen_name;
      if ('email' in ru) ru['email'] = identity.email;
      if ('first_name' in ru) ru['first_name'] = identity.first_name;
      if ('last_name' in ru) ru['last_name'] = identity.last_name;
      if ('username' in ru) ru['username'] = identity.screen_name;
    }
  }
}

function transformSagaLearnSessions(
  coll: MongoCollectionPayload,
  map: DeidentifyMap,
): void {
  for (const doc of coll.documents) {
    if ('title' in doc) {
      const id = doc['id'];
      const suffix = typeof id === 'string' ? id.slice(0, 8) : 'session';
      doc['title'] = `Session ${suffix}`;
    }
    const notes = doc['notes'];
    if (Array.isArray(notes)) {
      for (const note of notes) {
        if (note === null || typeof note !== 'object') continue;
        const n = note as Record<string, unknown>;
        if ('text' in n) n['text'] = '[note redacted]';
        if ('body' in n) n['body'] = '[note redacted]';
        if ('author' in n) {
          const author = n['author'];
          if (typeof author === 'string') {
            const identity = map.by_user_id.get(author);
            n['author'] = identity ? identity.screen_name : '[author redacted]';
          }
        }
      }
    }
  }
}

function maskUserId(user_id: string): string {
  return user_id.replace(/[^a-zA-Z0-9-]/g, '');
}

export const DEIDENTIFIED_MONGO_COLLECTIONS = [
  'iam_user_profiles',
  'iam_orgs',
  'saga_learn_sessions',
] as const;
