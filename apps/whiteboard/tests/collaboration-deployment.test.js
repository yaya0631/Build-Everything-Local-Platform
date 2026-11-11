import test from "node:test";
import assert from "node:assert/strict";
import { deploy, refreshDeployment } from "../src/collaboration/api.js";
import { environment, owner, editor } from "./collaboration-helpers.js";
import { createOrganization } from "../src/organization/client.js";

const key = "whiteboard-collaboration-worker-v1";
const server = "http://whiteboard-test.localhost:8443";
const source = "/* whiteboard-worker build=faceb00cfaceb00c at=200 */";
const previous = {
  name: "whiteboard-test",
  server,
  path: "whiteboard/whiteboard-worker.js",
  build: "0000000000000000",
  builtAt: 100,
};

async function fixture(t, config = previous) {
  const env = environment(),
    everything = env.sdk(owner);
  if (config) await everything.kv.set(key, config);
  const counts = { fetch: 0, write: 0, health: 0, create: 0 };
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    counts.fetch++;
    assert.equal(url, "/worker/whiteboard-worker.js");
    return new Response(source);
  });
  const write = everything.fs.write;
  everything.fs.write = async (...args) => {
    counts.write++;
    return write(...args);
  };
  everything.workers.create = async () => {
    counts.create++;
    throw Error("Unexpected new worker");
  };
  everything.workers.exec = async (url, options) => {
    counts.health++;
    assert.equal(url, server + "/health");
    assert.equal(options.headers["x-everything-no-auth"], "1");
    return Response.json({ build: env.data.get(key).build });
  };
  return { env, everything, counts, fetch };
}

test("existing worker updates retain their URL and share one check across boards", async (t) => {
  const { env, everything, counts } = await fixture(t);
  const first = refreshDeployment(everything, server);
  assert.equal(refreshDeployment(everything, server), first);
  assert.equal(await first, server);
  assert.equal(await refreshDeployment(everything, server), server);
  assert.equal(env.files.get(previous.path), source);
  assert.deepEqual(env.data.get(key), {
    ...previous,
    build: "faceb00cfaceb00c",
    builtAt: 200,
  });
  assert.deepEqual(counts, { fetch: 1, write: 1, health: 1, create: 0 });
});

test("invitation servers and accounts without deployments cannot trigger worker writes", async (t) => {
  const { env, everything, counts } = await fixture(t);
  await refreshDeployment(env.sdk(editor), server);
  await refreshDeployment(everything, "http://another-owner.localhost:8443");
  await everything.kv.del(key);
  await refreshDeployment(everything, server);
  assert.deepEqual(counts, { fetch: 0, write: 0, health: 0, create: 0 });
  assert.equal(env.files.size, 0);
});

test("failed background updates can retry without replacing the deployment", async (t) => {
  const { env, everything, counts, fetch } = await fixture(t);
  fetch.mock.mockImplementationOnce(
    async () => new Response("Unavailable", { status: 503 }),
  );
  await assert.rejects(refreshDeployment(everything, server), /could not load/);
  assert.deepEqual(env.data.get(key), previous);
  assert.equal(counts.write, 0);
  assert.equal(await refreshDeployment(everything, server), server);
  assert.equal(counts.write, 1);
  assert.equal(counts.create, 0);
});

test("a worker newer than the downloaded bundle is not downgraded", async (t) => {
  const newer = { ...previous, builtAt: 300 };
  const { env, everything, counts } = await fixture(t, newer);
  await refreshDeployment(everything, server);
  assert.equal(counts.write, 0);
  assert.deepEqual(env.data.get(key), newer);
});

test("sharing a new board already satisfies the background deployment check", async (t) => {
  const { everything, counts } = await fixture(t);
  await deploy(everything);
  await refreshDeployment(everything, server);
  assert.deepEqual(counts, { fetch: 1, write: 1, health: 1, create: 0 });
});

test("changing accounts while the update loads cannot write to the next account", async (t) => {
  const { env, everything, counts, fetch } = await fixture(t);
  fetch.mock.mockImplementationOnce(async () => {
    everything.authToken = "another-account";
    return new Response(source);
  });
  await assert.rejects(refreshDeployment(everything, server), /account changed/);
  assert.equal(counts.write, 0);
  assert.deepEqual(env.data.get(key), previous);
  // The rejected check from the previous login cannot suppress this account's check.
  assert.equal(await refreshDeployment(everything, server), server);
  assert.equal(counts.write, 1);
});

test("organization requests update an owned worker before using its API", async (t) => {
  const { env, everything, counts } = await fixture(t);
  const organization = createOrganization({
    everything: () => everything,
    deploy,
    refreshDeployment,
    call: async (_everything, address) => {
      assert.equal(address, server);
      assert.equal(env.files.get(previous.path), source);
      assert.equal(counts.health, 1);
      return { role: "owner" };
    },
  });
  await organization.use(server);
  await organization.request("org.users.list");
  await organization.preview(server);
  assert.deepEqual(counts, { fetch: 1, write: 1, health: 1, create: 0 });
});

test("organization requests remain available if an owned worker update cannot load", async (t) => {
  const { everything, fetch } = await fixture(t);
  fetch.mock.mockImplementation(
    async () => new Response("Unavailable", { status: 503 }),
  );
  const organization = createOrganization({
    everything: () => everything,
    deploy,
    refreshDeployment,
    call: async () => ({ role: "owner" }),
  });
  assert.equal((await organization.use(server)).role, "owner");
  assert.equal((await organization.request("org.users.list")).role, "owner");
});
