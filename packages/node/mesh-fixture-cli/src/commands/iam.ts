/**
 * iam:* — rostering iam-api seed commands.
 *
 * Each command is idempotent by natural key:
 *   iam:create-org       — dedup by (source, sourceId) via groups.findBySourceBulk
 *   iam:create-user      — dedup by username via users.search
 *   iam:add-membership   — groups.addMembers; absorbs "already member" errors
 *
 * Auth: assumes iam-api is running with AUTH_AUTHENABLED=false (dev mode).
 * In that mode, protected procedures are reachable without a session
 * cookie, so the CLI makes plain tRPC calls. The --as flag is accepted
 * for forward-compat but currently ignored.
 *
 * Source convention: every object created by the CLI is stamped with
 * source=demo (default) + sourceId=<slug>. That lets the same fixture-id's
 * groups be resolved back to UUIDs across separate CLI invocations.
 */

import type { Command } from 'commander';
import { TrpcClient, TrpcCallError } from '../lib/http.js';

const DEFAULT_ADMIN_EMAIL =
  process.env.SAGA_MESH_ADMIN_EMAIL ?? 'demo-tutor@fixture.test';
const DEFAULT_SOURCE = 'demo';

interface GlobalOpts {
  iamUrl: string;
  programsUrl: string;
  adsAdmUrl: string;
  porcelain: boolean;
  outputJson: boolean;
}

interface Group {
  id: string;
  kind: string;
  displayName: string | null;
  source: string | null;
  sourceId: string | null;
}

interface User {
  id: string;
  username: string;
}

async function findGroupBySourceId(
  iamClient: TrpcClient,
  source: string,
  sourceId: string,
): Promise<Group | null> {
  const groups = await iamClient.query<Group[]>('groups.findBySourceBulk', {
    source,
    sourceIds: [sourceId],
  });
  return groups.find((g) => g.sourceId === sourceId) ?? null;
}

async function findUserByUsername(
  iamClient: TrpcClient,
  username: string,
): Promise<User | null> {
  const result = await iamClient.query<{ items: User[]; total: number }>(
    'users.search',
    { username, limit: 1 },
  );
  return result.items.find((u) => u.username === username) ?? null;
}

function logJsonOrText(
  outputJson: boolean,
  porcelain: boolean,
  json: object,
  textLines: string[],
): void {
  if (outputJson) {
    console.log(JSON.stringify(json, null, 2));
  } else if (porcelain) {
    // One line per key=value pair
    for (const [k, v] of Object.entries(json)) {
      console.log(`${k}=${v as string}`);
    }
  } else {
    for (const line of textLines) console.log(line);
  }
}

export function registerIamCommands(program: Command): void {
  const iam = program
    .command('iam')
    .description('rostering iam-api seed commands.');

  iam
    .command('create-org')
    .description('Create a group (org/school/section) — dedup by (source, sourceId).')
    .requiredOption('--fixture-id <id>', 'fixture identifier (not currently persisted; future D3.2)')
    .requiredOption('--slug <slug>', 'stable slug; becomes sourceId')
    .requiredOption('--kind <kind>', 'group kind (e.g. district | school | section)')
    .option('--parent <parent-slug>', 'parent group slug (must already exist)')
    .option('--display-name <name>', 'human display name (defaults to slug)')
    .option('--source <source>', 'dedup namespace (default: demo)', DEFAULT_SOURCE)
    .option('--as <email>', 'fixture-admin email for devLogin (ignored when AUTH_ENABLED=false)', DEFAULT_ADMIN_EMAIL)
    .action(async (opts, cmd) => {
      const { iamUrl, porcelain, outputJson } = cmd.optsWithGlobals<GlobalOpts>();
      const client = new TrpcClient({ baseUrl: iamUrl });

      // Dedup check.
      const existing = await findGroupBySourceId(client, opts.source, opts.slug);
      if (existing) {
        logJsonOrText(
          outputJson,
          porcelain,
          { groupId: existing.id, kind: existing.kind, dedup: 'hit' },
          [`  hit    ${existing.kind}/${opts.slug} → ${existing.id}`],
        );
        return;
      }

      // Resolve parent (if any).
      let parentGroupId: string | undefined;
      if (opts.parent) {
        const parent = await findGroupBySourceId(client, opts.source, opts.parent);
        if (!parent) {
          throw new Error(
            `parent group with sourceId='${opts.parent}' not found. Create it first.`,
          );
        }
        parentGroupId = parent.id;
      }

      const created = await client.mutation<Group>('groups.create', {
        kind: opts.kind,
        displayName: opts.displayName ?? opts.slug,
        parentGroupId,
        source: opts.source,
        sourceId: opts.slug,
      });
      logJsonOrText(
        outputJson,
        porcelain,
        { groupId: created.id, kind: created.kind, dedup: 'miss' },
        [`  new    ${created.kind}/${opts.slug} → ${created.id}`],
      );
    });

  iam
    .command('create-user')
    .description('Create a user — dedup by username (via users.search).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--username <username>', 'unique username (dedup key)')
    .requiredOption('--email <email>', 'email')
    .option('--name-first <name>', 'first name', 'Demo')
    .option('--name-last <name>', 'last name')
    .option('--screen-name <name>', 'screen name (defaults to username)')
    .option('--as <email>', 'fixture-admin email for devLogin (ignored when AUTH_ENABLED=false)', DEFAULT_ADMIN_EMAIL)
    .action(async (opts, cmd) => {
      const { iamUrl, porcelain, outputJson } = cmd.optsWithGlobals<GlobalOpts>();
      const client = new TrpcClient({ baseUrl: iamUrl });

      const existing = await findUserByUsername(client, opts.username);
      if (existing) {
        logJsonOrText(
          outputJson,
          porcelain,
          { userId: existing.id, username: existing.username, dedup: 'hit' },
          [`  hit    user/${opts.username} → ${existing.id}`],
        );
        return;
      }

      // iam-api's users.create accepts UserInput shape from PR #101.
      const created = await client.mutation<User>('users.create', {
        username: opts.username,
        profile: {
          screenName: opts.screenName ?? opts.username,
          primaryLanguage: 'en',
        },
        pii: {
          email: opts.email,
          nameFirst: opts.nameFirst,
          nameLast: opts.nameLast ?? opts.username,
        },
      });
      logJsonOrText(
        outputJson,
        porcelain,
        { userId: created.id, username: created.username, dedup: 'miss' },
        [`  new    user/${opts.username} → ${created.id}`],
      );
    });

  iam
    .command('add-membership')
    .description('Add a user to a group by slug-or-UUID. Parent-first ordering enforced by iam.')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--user <username-or-uuid>', 'user (username or UUID)')
    .requiredOption('--group <slug-or-uuid>', 'target group (sourceId or UUID)')
    .option('--source <source>', 'source for slug lookup', DEFAULT_SOURCE)
    .option('--as <email>', 'fixture-admin email for devLogin (ignored when AUTH_ENABLED=false)', DEFAULT_ADMIN_EMAIL)
    .action(async (opts, cmd) => {
      const { iamUrl, porcelain, outputJson } = cmd.optsWithGlobals<GlobalOpts>();
      const client = new TrpcClient({ baseUrl: iamUrl });

      // Resolve user (accept either UUID or username).
      let userId: string;
      if (/^[0-9a-f]{8}-/.test(opts.user)) {
        userId = opts.user;
      } else {
        const user = await findUserByUsername(client, opts.user);
        if (!user) throw new Error(`user '${opts.user}' not found (by username).`);
        userId = user.id;
      }

      // Resolve group (accept either UUID or slug).
      let groupId: string;
      if (/^[0-9a-f]{8}-/.test(opts.group)) {
        groupId = opts.group;
      } else {
        const group = await findGroupBySourceId(client, opts.source, opts.group);
        if (!group) throw new Error(`group '${opts.group}' not found (by sourceId).`);
        groupId = group.id;
      }

      try {
        // AddMembersInputSchema expects `members: [{userId, roleId?, source?}]`,
        // not a flat `userIds` array (that's RemoveMembers).
        await client.mutation('groups.addMembers', {
          groupId,
          members: [{ userId, source: opts.source }],
        });
      } catch (err) {
        // addMembers throws if the user is already a member. Absorb that
        // into dedup=hit so the command is idempotent.
        if (err instanceof TrpcCallError && /already/i.test(err.trpcError?.message ?? '')) {
          logJsonOrText(
            outputJson,
            porcelain,
            { userId, groupId, dedup: 'hit' },
            [`  hit    membership ${userId.slice(0, 8)}... in ${groupId.slice(0, 8)}...`],
          );
          return;
        }
        throw err;
      }
      logJsonOrText(
        outputJson,
        porcelain,
        { userId, groupId, dedup: 'miss' },
        [`  new    membership ${userId.slice(0, 8)}... in ${groupId.slice(0, 8)}...`],
      );
    });
}
