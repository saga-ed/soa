/**
 * Engine configurations for EC2-hosted database containers.
 * Each engine defines image, ports, env vars, health checks, and data paths.
 */

export const engines = {
    postgres: {
        image_template: 'postgres:{version}',
        default_version: '16',
        container_data_path: '/var/lib/postgresql/data',
        port_range: [5432, 5440],
        default_port: 5432,
        seed_ext: 'sql',
        default_user: 'postgres_admin',
        dump_cmd: (container, db_name, user) => [
            'docker', 'exec', container,
            'pg_dump', '-U', user || 'postgres_admin', '--no-owner', '--no-acl', db_name,
        ],
        env_vars: ({ db_name }) => ({
            POSTGRES_DB: db_name,
            POSTGRES_USER: 'postgres_admin',
            POSTGRES_PASSWORD: 'password123',
            POSTGRES_HOST_AUTH_METHOD: 'trust',
            PGDATA: '/var/lib/postgresql/data/pgdata',
        }),
        healthcheck: {
            test: ['CMD-SHELL', 'pg_isready -U postgres_admin'],
            interval: '5s',
            timeout: '3s',
            retries: 10,
        },
    },

    mongo: {
        image_template: 'mongo:{version}',
        default_version: '6',
        container_data_path: '/data/db',
        port_range: [27017, 27020],
        default_port: 27017,
        seed_ext: 'json',
        env_vars: ({ db_name }) => ({
            MONGO_INITDB_DATABASE: db_name,
        }),
        healthcheck: {
            test: ['CMD', 'mongosh', '--eval', "db.adminCommand('ping')"],
            interval: '5s',
            timeout: '3s',
            retries: 10,
        },
    },

    mysql: {
        image_template: 'mysql:{version}',
        default_version: '8.0',
        container_data_path: '/var/lib/mysql',
        port_range: [3306, 3310],
        default_port: 3306,
        seed_ext: 'sql',
        default_user: 'root',
        dump_cmd: (container, db_name, user, password) => {
            const args = ['docker', 'exec', container, 'mysqldump', '-u', user || 'root'];
            if (password) args.push(`-p${password}`);
            args.push('--no-tablespaces', '--routines', '--triggers', '--databases', db_name);
            return args;
        },
        env_vars: ({ db_name }) => ({
            MYSQL_DATABASE: db_name,
            MYSQL_ROOT_PASSWORD: 'password123',
            MYSQL_USER: 'mysql_admin',
            MYSQL_PASSWORD: 'password123',
        }),
        healthcheck: {
            test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
            interval: '5s',
            timeout: '3s',
            retries: 10,
        },
    },
};
