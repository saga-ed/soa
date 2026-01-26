The module contains helpers for managing connections to specific database applications.

The databases that are currently supported are MongoDB, SQL (MySQL in AWS RDS), and Redis.

This module should make use of inversify.io to manage shared instances of these helpers.
Inversify is used by other modules in this turborepo managed monorepo so care should be taken

There are going to be multiple instances of each database manager corresponding to
connections to different database instances.
