// init-and-seed.js
//
// 1. Ensure replica set is initialized (idempotent)
// 2. Wait for primary
// 3. Seed the active profile if not already seeded
//
// Runs via: mongosh --host mongo:27017 --file /seed/init-and-seed.js

// --- Step 1: Replica set ---
try {
  const status = rs.status();
  print("RS: already initialized (state: " + status.myState + ")");
} catch (e) {
  print("RS: initializing...");
  rs.initiate({
    _id: "wootmath",
    members: [{ _id: 0, host: "localhost:27017" }],
  });
  print("RS: initiated");
}

// --- Step 2: Wait for primary (status + write-readiness) ---
print("RS: waiting for primary...");
let attempts = 0;
while (attempts < 30) {
  try {
    const status = rs.status();
    const me = status.members.find((m) => m.self);
    if (me && me.stateStr === "PRIMARY") {
      // Probe actual write-readiness — rs.status() can report PRIMARY
      // before the node is ready to accept writes after election.
      try {
        const probe = db.getSiblingDB("admin");
        probe.getCollection("__write_probe").insertOne({ _id: "probe" });
        probe.getCollection("__write_probe").drop();
        print("RS: primary ready (write-verified)");
        break;
      } catch (writeErr) {
        print("RS: primary reported but writes not ready yet...");
      }
    }
  } catch (_) {
    // ignore
  }
  sleep(1000);
  attempts++;
}
if (attempts >= 30) {
  print("ERROR: timed out waiting for primary");
  quit(1);
}

// --- Step 3: Seed if needed ---
const profile = process.env.SEED_PROFILE || "small";
const seedFile = `/seed/profile-${profile}.json`;

print(`Seed: profile=${profile}`);

// Check if already seeded by looking for a sentinel collection
const sentinel = db.getSiblingDB("saga_db").getCollection("_profile_meta");
const existing = sentinel.findOne({ profile: profile });

if (existing) {
  print(`Seed: profile '${profile}' already seeded at ${existing.seeded_at} — skipping`);
} else {
  print(`Seed: loading ${seedFile} ...`);

  const raw = fs.readFileSync(seedFile, "utf8");
  const spec = JSON.parse(raw);

  for (const [dbName, collections] of Object.entries(spec)) {
    print(`  db: ${dbName}`);
    const target = db.getSiblingDB(dbName);

    for (const [collName, docs] of Object.entries(collections)) {
      if (!Array.isArray(docs) || docs.length === 0) continue;
      const result = target[collName].insertMany(docs);
      print(
        `    ${collName}: inserted ${Object.keys(result.insertedIds).length} docs`
      );
    }
  }

  // Write sentinel
  sentinel.insertOne({
    profile: profile,
    seeded_at: new Date().toISOString(),
    seed_file: seedFile,
  });

  print(`Seed: profile '${profile}' complete`);
}

print("init-and-seed: done");
