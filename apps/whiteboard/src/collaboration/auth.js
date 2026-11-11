import { hash, keyPair, sign } from "./protocol.js";

const credentials = new WeakMap();
const lifetime = 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function loadCredential(everything, parent, refused) {
  // App KV is private to this account. Persist across reloads to avoid minting
  // a new Everything access token for every board or tab (a rate-limited operation).
  const context = await hash(parent);
  const key = `whiteboard-collaboration-auth-v1:${context}`;
  const saved = await everything.kv.get(key);
  if (
    saved?.expires > Date.now() + 60_000 &&
    (!refused || saved.token !== refused.token)
  )
    return saved;
  const keys = saved?.keys || (await keyPair());
  // Concurrent first-time tabs may generate different keys. Give each proof
  // its own file so the last KV write cannot invalidate an earlier tab.
  const fingerprint = (await hash(JSON.stringify(keys.publicKey))).slice(0, 32);
  const file = await everything.fs.write(
    `whiteboard/identity/${context}-${fingerprint}.json`,
    JSON.stringify({ version: 1, publicKey: keys.publicKey }),
    { overwrite: true, dedupeName: false, createMissingParents: true },
  );
  const issued = Date.now();
  const url = new URL(await everything.fs.getReadURL(file.path, "24h"));
  const token = url.searchParams.get("token");
  const claims = tokenClaims(token);
  if (
    url.origin !== new URL(everything.APIOrigin).origin ||
    url.pathname !== "/token-read" ||
    !token ||
    token === parent ||
    claims.type !== "access-token" ||
    claims.full_access ||
    !Number.isFinite(claims.exp)
  )
    throw Error("Could not create a restricted collaboration credential.");
  const credential = {
    keys,
    path: file.path,
    token,
    expires: Math.min(issued + lifetime, claims.exp * 1000),
  };
  if (everything.authToken !== parent)
    throw Error("Your Everything account changed. Reopen the shared board.");
  await everything.kv.set(key, credential, { disableSharing: true });
  return credential;
}

export function tokenClaims(token) {
  try {
    const claims = JSON.parse(
      atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (
      !claims ||
      typeof claims !== "object" ||
      Array.isArray(claims) ||
      (claims.t !== undefined && claims.type !== undefined) ||
      (claims.uu !== undefined && claims.user_uid !== undefined)
    )
      return {};
    // Everything's TokenService compresses auth types on the wire. Expiry and the
    // full-access flag keep their full names. This only decodes metadata;
    // worker authentication still validates the token through Everything itself.
    const type =
      claims.t === undefined
        ? claims.type
        : claims.t === "t"
          ? "access-token"
          : claims.t === "au"
            ? "app-under-user"
            : claims.t === "s"
              ? "session"
              : undefined;
    const subject = claims.uu ?? claims.user_uid;
    let user_uid;
    if (typeof subject === "string") {
      if (uuid.test(subject)) user_uid = subject.toLowerCase();
      else if (claims.uu !== undefined) {
        const packed = atob(subject.replaceAll("-", "+").replaceAll("_", "/"));
        if (packed.length === 16) {
          const hex = [...packed]
            .map((byte) => byte.charCodeAt(0).toString(16).padStart(2, "0"))
            .join("");
          user_uid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
      }
    }
    return { ...claims, type, user_uid };
  } catch {
    return {};
  }
}

// A credential the worker refused before its recorded expiry, as when its
// identity file was removed or the token revoked, is replaced rather than
// reused until then. Replacing it again within a minute would not help, as
// something else refuses it, and minting is rate-limited. Returns whether
// it was replaced.
const replaced = new WeakMap();
export function refuseCredential(everything, headers) {
  const entry = credentials.get(everything),
    value = entry?.value;
  // Replaced already, or being replaced, for a request refused at the
  // same time: sent again with the new one.
  if (
    entry &&
    (entry.stale || !value || value.token !== headers?.["everything-auth"])
  )
    return true;
  if (!value) return false;
  if (Date.now() - (replaced.get(everything) || 0) < 60_000) return false;
  replaced.set(everything, Date.now());
  credentials.set(everything, { parent: entry.parent, stale: true, refused: value });
  return true;
}

export async function authorize(everything, server, body) {
  const parent = everything.authToken;
  if (!parent) throw Error("Sign in with Everything to continue.");
  let entry = credentials.get(everything);
  if (
    entry?.parent !== parent ||
    entry.stale ||
    (entry.value && entry.value.expires <= Date.now() + 60_000)
  ) {
    const refused = entry?.stale && entry.parent === parent && entry.refused;
    entry = { parent };
    credentials.set(everything, entry);
    entry.pending = loadCredential(everything, parent, refused).then(
      (value) => (entry.value = value),
      (error) => {
        if (credentials.get(everything) === entry) credentials.delete(everything);
        throw error;
      },
    );
  }
  const credential = await entry.pending;
  const signature = await sign(credential.keys.privateKey, [
    server,
    credential.path,
    await hash(body),
  ]);
  if (everything.authToken !== parent)
    throw Error("Your Everything account changed. Reopen the shared board.");
  return {
    "everything-auth": credential.token,
    "x-whiteboard-proof": JSON.stringify({
      version: 1,
      path: credential.path,
      signature,
    }),
  };
}
