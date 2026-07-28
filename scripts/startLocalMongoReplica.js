const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { MongoClient } = require("mongodb");

const PORT = 27018;
const REPLICA_SET = "rs0";
const backendRoot = path.resolve(__dirname, "..");
const localMongoRoot = path.join(backendRoot, ".local-mongodb-rs");
const dataPath = path.join(localMongoRoot, "data");
const logPath = path.join(localMongoRoot, "mongod.log");
const directUri = `mongodb://127.0.0.1:${PORT}/?directConnection=true`;
const replicaUri = `mongodb://localhost:${PORT}/admin?replicaSet=${REPLICA_SET}`;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const findMongod = () => {
  if (process.env.LOCAL_MONGOD_PATH) {
    return process.env.LOCAL_MONGOD_PATH;
  }

  const serverRoot = "C:\\Program Files\\MongoDB\\Server";
  const versions = fs
    .readdirSync(serverRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    );

  for (const version of versions) {
    const executable = path.join(serverRoot, version, "bin", "mongod.exe");
    if (fs.existsSync(executable)) return executable;
  }

  throw new Error(
    "mongod.exe was not found. Set LOCAL_MONGOD_PATH to its full path.",
  );
};

const connectDirectly = async (timeoutMs = 1000) => {
  const client = new MongoClient(directUri, {
    serverSelectionTimeoutMS: timeoutMs,
  });
  await client.connect();
  return client;
};

const ensureMongoProcess = async () => {
  try {
    const existing = await connectDirectly();
    await existing.close();
    return false;
  } catch {
    fs.mkdirSync(dataPath, { recursive: true });
    const child = spawn(
      findMongod(),
      [
        "--dbpath",
        dataPath,
        "--port",
        String(PORT),
        "--bind_ip",
        "127.0.0.1",
        "--replSet",
        REPLICA_SET,
        "--logpath",
        logPath,
        "--logappend",
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const client = await connectDirectly();
      await client.close();
      return true;
    } catch {
      await sleep(1000);
    }
  }

  throw new Error(`MongoDB did not start on port ${PORT}. Check ${logPath}.`);
};

const ensureReplicaSet = async () => {
  const direct = await connectDirectly(5000);
  try {
    await direct.db("admin").command({
      replSetInitiate: {
        _id: REPLICA_SET,
        members: [{ _id: 0, host: `localhost:${PORT}` }],
      },
    });
  } catch (error) {
    if (error.codeName !== "AlreadyInitialized") throw error;
  } finally {
    await direct.close();
  }

  const replica = new MongoClient(replicaUri, {
    serverSelectionTimeoutMS: 30000,
  });
  await replica.connect();
  const status = await replica.db("admin").command({ hello: 1 });
  await replica.close();

  if (!status.isWritablePrimary || status.setName !== REPLICA_SET) {
    throw new Error("The local replica set did not become a writable primary.");
  }
};

const main = async () => {
  const started = await ensureMongoProcess();
  await ensureReplicaSet();
  console.log(
    `${started ? "Started" : "Found"} local MongoDB replica set ${REPLICA_SET} on port ${PORT}.`,
  );
  console.log(
    `Use MONGO_URI="mongodb://localhost:${PORT}/DBdemo?replicaSet=${REPLICA_SET}"`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
