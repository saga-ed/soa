import { describe, it, expect } from 'vitest';

// Test the role mapping and suite assignment logic used in build_playwright_export
// without needing MongoDB — pure logic tests

describe('build_playwright_export logic', () => {
    const role_mappings: Record<string, string[]> = {
        SUPERINTENDENT: ['SUPERINTENDENT'],
        DIRECTOR_OF_PROGRAMS: ['DOP', 'SUPERINTENDENT'],
        TUTOR: ['TUTOR'],
        SCHOLAR: ['STUDENT'],
    };

    const suite_roles: Record<string, string[]> = {
        auth: ['SUPERINTENDENT', 'DOP', 'TUTOR', 'STUDENT'],
        dashboard: ['SUPERINTENDENT', 'DOP'],
        sessions: ['SUPERINTENDENT', 'TUTOR', 'STUDENT'],
    };

    function build_credentials(
        user_ids: string[],
        user_roles: Record<string, string>,
        user_emails: Record<string, string>,
        mappings: Record<string, string[]>,
        suites: Record<string, string[]>,
        password = 'saga',
    ) {
        const credentials_by_role = new Map<string, { username: string; password: string; user_type: string }[]>();

        for (const user_id of user_ids) {
            const domain_role = user_roles[user_id];
            const login = user_emails[user_id];
            if (!login || !domain_role) continue;
            const playwright_roles = mappings[domain_role];
            if (!playwright_roles) continue;
            for (const pw_role of playwright_roles) {
                if (!credentials_by_role.has(pw_role)) credentials_by_role.set(pw_role, []);
                credentials_by_role.get(pw_role)!.push({ username: login, password, user_type: pw_role });
            }
        }

        const user_logins: Record<string, Record<string, any[]>> = {};
        for (const [suite, roles] of Object.entries(suites)) {
            const suite_data: Record<string, any[]> = {};
            for (const role of roles) {
                const creds = credentials_by_role.get(role);
                if (creds && creds.length > 0) suite_data[role] = creds;
            }
            if (Object.keys(suite_data).length > 0) user_logins[suite] = suite_data;
        }
        return { user_logins, credentials_by_role };
    }

    it('should map domain roles to playwright roles', () => {
        const { credentials_by_role } = build_credentials(
            ['u1'],
            { u1: 'SUPERINTENDENT' },
            { u1: 'super@test.edu' },
            role_mappings,
            suite_roles,
        );
        expect(credentials_by_role.get('SUPERINTENDENT')).toHaveLength(1);
        expect(credentials_by_role.get('SUPERINTENDENT')![0].username).toBe('super@test.edu');
    });

    it('should map one domain role to multiple playwright roles', () => {
        const { credentials_by_role } = build_credentials(
            ['u1'],
            { u1: 'DIRECTOR_OF_PROGRAMS' },
            { u1: 'dop@test.edu' },
            role_mappings,
            suite_roles,
        );
        // DOP maps to both 'DOP' and 'SUPERINTENDENT'
        expect(credentials_by_role.get('DOP')).toHaveLength(1);
        expect(credentials_by_role.get('SUPERINTENDENT')).toHaveLength(1);
    });

    it('should group credentials by suite', () => {
        const { user_logins } = build_credentials(
            ['u1', 'u2'],
            { u1: 'SUPERINTENDENT', u2: 'TUTOR' },
            { u1: 'super@test.edu', u2: 'tutor@test.edu' },
            role_mappings,
            suite_roles,
        );
        expect(user_logins.auth).toBeDefined();
        expect(user_logins.auth.SUPERINTENDENT).toHaveLength(1);
        expect(user_logins.auth.TUTOR).toHaveLength(1);
        expect(user_logins.dashboard).toBeDefined();
        expect(user_logins.dashboard.SUPERINTENDENT).toHaveLength(1);
        expect(user_logins.dashboard.TUTOR).toBeUndefined(); // TUTOR not in dashboard suite
    });

    it('should skip users without email', () => {
        const { credentials_by_role } = build_credentials(
            ['u1'],
            { u1: 'SUPERINTENDENT' },
            {}, // no email
            role_mappings,
            suite_roles,
        );
        expect(credentials_by_role.size).toBe(0);
    });

    it('should skip users with unmapped roles', () => {
        const { credentials_by_role } = build_credentials(
            ['u1'],
            { u1: 'UNKNOWN_ROLE' },
            { u1: 'user@test.edu' },
            role_mappings,
            suite_roles,
        );
        expect(credentials_by_role.size).toBe(0);
    });

    it('should omit suites with no matching credentials', () => {
        const { user_logins } = build_credentials(
            ['u1'],
            { u1: 'TUTOR' },
            { u1: 'tutor@test.edu' },
            role_mappings,
            suite_roles,
        );
        // TUTOR is in auth and sessions, not dashboard
        expect(user_logins.auth).toBeDefined();
        expect(user_logins.sessions).toBeDefined();
        expect(user_logins.dashboard).toBeUndefined();
    });
});
