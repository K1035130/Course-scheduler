const { MongoClient, ServerApiVersion } = require("mongodb");
const dns = require("dns");

// Prefer IPv4 to avoid SRV/IPv6 connection issues on some networks.
dns.setDefaultResultOrder("ipv4first");

// Optional: override DNS servers for SRV lookup issues (comma-separated).
const dnsServers = process.env.MONGODB_DNS_SERVERS || "";
if (dnsServers) {
  const list = dnsServers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) {
    dns.setServers(list);
    console.log("[MongoDB] DNS servers:", list.join(", "));
  }
}

const uri = process.env.MONGODB_URI || "";
const dbName = process.env.MONGODB_DB || process.env.DB_NAME || "";

let client;
let db;

const connectToMongo = async () => {
  if (db) return db;

  if (!uri) {
    throw new Error(
      "Missing MONGODB_URI. Set it in backend/.env before starting the server."
    );
  }
  if (!dbName) {
    throw new Error(
      "Missing MONGODB_DB (or DB_NAME). Set it in backend/.env before starting the server."
    );
  }

  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  db = client.db(dbName);
  console.log("[MongoDB] connected");
  return db;
};

const getDb = () => {
  if (!db) {
    throw new Error("MongoDB not connected. Call connectToMongo() first.");
  }
  return db;
};

const closeMongo = async () => {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
};

module.exports = {
  connectToMongo,
  getDb,
  closeMongo,
};
