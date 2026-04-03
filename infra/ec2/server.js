/**
 * Standalone Express server for the EC2 db-host API.
 * Runs directly on the EC2 instance to manage database containers.
 *
 * Environment variables:
 *   DB_HOST_PORT          — listen port (default: 8080)
 *   CLOUDMAP_NAMESPACE_ID — Cloud Map namespace for service discovery (optional)
 *   AWS_REGION            — AWS region (auto-detected from instance metadata if omitted)
 *   PROJECTS_DIR          — compose project root (default: /opt/db-manager/projects)
 *   DATA_DIR              — EBS mount root (default: /mnt/data)
 *   PORT_REGISTRY_PATH    — port registry file (default: /opt/db-manager/port-registry.json)
 */

import express from 'express';
import { create_ec2_router } from './ec2-router.js';
import { get_instance_metadata } from './volumes.js';

const port = parseInt(process.env.DB_HOST_PORT || '8080', 10);
const projects_dir = process.env.PROJECTS_DIR || '/opt/db-manager/projects';
const data_dir = process.env.DATA_DIR || '/mnt/data';
const namespace_id = process.env.CLOUDMAP_NAMESPACE_ID;
const registry_path = process.env.PORT_REGISTRY_PATH;

let region = process.env.AWS_REGION;
if (!region) {
    try {
        region = get_instance_metadata().region;
    } catch {
        console.warn('Could not detect region from instance metadata, AWS_REGION not set');
    }
}

const app = express();

app.use(create_ec2_router({
    projects_dir,
    data_dir,
    namespace_id,
    region,
    registry_path,
}));

app.listen(port, () => {
    console.log(`db-host API listening on port ${port}`);
    console.log(`  projects_dir: ${projects_dir}`);
    console.log(`  data_dir:     ${data_dir}`);
    console.log(`  region:       ${region || '(not set)'}`);
    console.log(`  namespace_id: ${namespace_id || '(not set)'}`);
});
