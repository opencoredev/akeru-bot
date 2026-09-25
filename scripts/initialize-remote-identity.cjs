const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const baseDir = process.env.AKERU_HOME || path.join(require("node:os").homedir(), ".akeru");
const directory = path.join(baseDir, "userdata");
const identityPath = path.join(directory, "remote-link-identity.json");
const idPath = path.join(directory, "environment-id");
const tokenPath = path.join(directory, "remote-control-token");
const journalPath = path.join(directory, "remote-identity-migration.json");
fs.mkdirSync(directory, { recursive: true });

function syncDirectory() {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function atomicWrite(destination, contents) {
  const temporary = `${destination}.new-${process.pid}`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  syncDirectory();
}
const readId = () => fs.existsSync(idPath) ? fs.readFileSync(idPath, "utf8").trim() : "";
const readIdentity = () => {
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  if (typeof identity.environmentId !== "string" || !identity.environmentId) throw new Error("invalid remote identity");
  return identity;
};

if (!fs.existsSync(journalPath) && (!fs.existsSync(identityPath) || fs.statSync(identityPath).size === 0) && readId() && process.env.AKERU_REMOTE_ALLOW_IDENTITY_MIGRATION !== "1") {
  throw new Error("This Akeru home already has an environment ID. Re-run with --migrate-environment-id only if you accept re-pairing existing clients. No identity was changed.");
}
if (!fs.existsSync(tokenPath) || fs.statSync(tokenPath).size === 0) atomicWrite(tokenPath, `${crypto.randomBytes(32).toString("base64url")}\n`);
try { fs.chmodSync(tokenPath, 0o600); } catch {}
if (fs.existsSync(journalPath)) {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!fs.existsSync(identityPath) && journal.identity?.environmentId === journal.newEnvironmentId) atomicWrite(identityPath, `${JSON.stringify(journal.identity)}\n`);
  const identity = readIdentity();
  const currentId = readId();
  if (journal.protocol !== 1 || journal.newEnvironmentId !== identity.environmentId || (currentId && currentId !== journal.oldEnvironmentId && currentId !== journal.newEnvironmentId)) throw new Error("remote identity migration journal does not match published state");
  if (currentId !== journal.newEnvironmentId) atomicWrite(idPath, `${journal.newEnvironmentId}\n`);
  fs.rmSync(journalPath, { force: true });
  syncDirectory();
}
if (fs.existsSync(identityPath) && fs.statSync(identityPath).size > 0) {
  const identity = readIdentity();
  const currentId = readId();
  if (currentId && currentId !== identity.environmentId) throw new Error("environment identity mismatch");
  if (!currentId) atomicWrite(idPath, `${identity.environmentId}\n`);
  process.exit(0);
}
const oldEnvironmentId = readId();
if (oldEnvironmentId && process.env.AKERU_REMOTE_ALLOW_IDENTITY_MIGRATION !== "1") throw new Error("Existing environment identity requires --migrate-environment-id.");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicJwk = publicKey.export({ format: "jwk" });
const environmentId = `env-${crypto.createHash("sha256").update(publicJwk.x).digest("hex")}`;
const identity = { environmentId, publicKey: publicJwk, privateKey: privateKey.export({ format: "jwk" }) };
if (oldEnvironmentId) {
  atomicWrite(`${idPath}.pre-remote-migration`, `${oldEnvironmentId}\n`);
  atomicWrite(journalPath, `${JSON.stringify({ protocol: 1, oldEnvironmentId, newEnvironmentId: environmentId, identity })}\n`);
}
atomicWrite(identityPath, `${JSON.stringify(identity)}\n`);
atomicWrite(idPath, `${environmentId}\n`);
if (oldEnvironmentId) { fs.rmSync(journalPath, { force: true }); syncDirectory(); }
