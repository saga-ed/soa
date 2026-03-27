// dump.js — Export all MongoDB data to profile seed format
//
// Usage: mongosh --host localhost:<port> --eval "var PROFILE='name'; var OUTPUT_DIR='/path'" --file dump.js
//
// Produces: profile-<PROFILE>.json in OUTPUT_DIR
// Format: { db_name: { collection_name: [docs] } } — same as init-and-seed.js expects
//
// @infra-compose/dump-script

if (typeof PROFILE === "undefined" || !PROFILE) {
  print("ERROR: PROFILE variable is required (--eval \"var PROFILE='name'\")");
  quit(1);
}

if (typeof OUTPUT_DIR === "undefined" || !OUTPUT_DIR) {
  print("ERROR: OUTPUT_DIR variable is required (--eval \"var OUTPUT_DIR='/path'\")");
  quit(1);
}

const EXCLUDED_DBS = ["admin", "config", "local"];
const EXCLUDED_COLLECTIONS = ["_profile_meta"];

print(`Dump: profile=${PROFILE} output=${OUTPUT_DIR}`);

const allDbs = db.adminCommand({ listDatabases: 1 }).databases;
const result = {};

for (const dbInfo of allDbs) {
  if (EXCLUDED_DBS.includes(dbInfo.name)) continue;

  const target = db.getSiblingDB(dbInfo.name);
  const collections = target.getCollectionNames().filter(
    (c) => !EXCLUDED_COLLECTIONS.includes(c) && !c.startsWith("system.")
  );

  if (collections.length === 0) continue;

  print(`  db: ${dbInfo.name}`);
  result[dbInfo.name] = {};

  for (const collName of collections) {
    const docs = target.getCollection(collName).find({}).toArray();
    if (docs.length === 0) continue;

    // Convert BSON types to JSON-safe representations
    const cleaned = docs.map((doc) => {
      return JSON.parse(EJSON.stringify(doc, { relaxed: true }));
    });

    result[dbInfo.name][collName] = cleaned;
    print(`    ${collName}: ${cleaned.length} docs`);
  }
}

// Add snapshot metadata
result["_meta"] = { type: "snapshot", profile: PROFILE, dumped_at: new Date().toISOString() };

const outPath = `${OUTPUT_DIR}/profile-${PROFILE}.json`;
const json = JSON.stringify(result, null, 2);

fs.writeFileSync(outPath, json);
print(`Dump: wrote ${outPath} (${json.length} bytes)`);
