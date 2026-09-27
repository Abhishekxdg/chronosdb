// End-to-end check against a running `chronos serve` (CHRONOS_URL, CHRONOS_TOKEN). Run: node test.ts
import assert from "node:assert/strict";
import { Chronos, ChronosError } from "./chronos.ts";

const db = new Chronos(process.env.CHRONOS_URL, { token: process.env.CHRONOS_TOKEN });

await db.batch([
  { table: "docs", id: "1", record: { about: "billing error on invoice", team: "core", e: [1, 0] } },
  { table: "docs", id: "2", record: { about: "login error", team: "core", e: [0, 1] } },
  { table: "docs", id: "3", record: { about: "billing question", team: "sales", e: [1, 0] } },
]);
assert.deepEqual(await db.get("docs", "1"), { about: "billing error on invoice", e: [1, 0], team: "core" });
assert.equal(await db.get("docs", "nope"), null);

const found = await db.find("docs", { where: { team: "core" }, text: "biling", vector: [1, 0], vectorField: "e", limit: 1 });
assert.equal(found.total, 2);
assert.equal(found.hits[0].id, "1", "typo-tolerant text + vector + filter");
assert.equal(found.nextOffset, 1);
assert.equal((await db.find("docs", { where: { team: "core" }, limit: 1, offset: 1 })).hits[0].id, "2");

const agent = await db.fork("agent-7", { owner: "ts", tags: ["billing"] });
const w = await agent.world();
assert.equal(w.parent, "main");
assert.deepEqual(w.meta, { owner: "ts", tags: ["billing"] });
assert.deepEqual((await agent.setMeta({ tags: null, reviewed: true })).meta, { owner: "ts", reviewed: true });
await agent.put("docs", "1", { about: "billing fixed", team: "core" });
await agent.delete("docs", "2");
assert.deepEqual((await agent.diff()).map((c) => c.key), ["docs/1", "docs/2"]);
assert.equal((await db.get("docs", "1"))?.about, "billing error on invoice", "main untouched until merge");

await db.put("docs", "1", { about: "edited on main too", team: "core" });
try {
  await agent.merge();
  assert.fail("expected a conflict");
} catch (e) {
  assert(e instanceof ChronosError && e.status === 409);
  assert.equal(e.conflicts[0].key, "docs/1");
  assert.equal((e.conflicts[0].ours as { about: string }).about, "billing fixed");
}
assert.equal(await agent.merge("ours"), 2);
assert.equal((await db.get("docs", "1"))?.about, "billing fixed");
assert.equal(await db.get("docs", "2"), null);
assert.deepEqual((await db.branches()).map((b) => b.name), ["main"]);

// SQL sees the same rows; writes through SQL count toward the branch version for merge
await db.sql("create table tasks (id integer primary key, title text not null, done boolean default false)");
const sqlAgent = await db.fork("sql-agent");
assert.equal((await sqlAgent.sql("insert into tasks (id, title) values ($1, $2), (2, 'ship')", [1, "write docs"])).command, "INSERT 0 2");
const open = await sqlAgent.sql<{ title: string }>("select title from tasks where not done order by id");
assert.deepEqual(open.rows.map((r) => r.title), ["write docs", "ship"]);
assert.equal(await sqlAgent.merge(), 2);
assert.equal((await db.sql("select title from tasks where id = $1", [2])).rows.length, 1);
await assert.rejects(db.sql("insert into tasks (id) values (3)"), (e: ChronosError) => e.status === 409);

await assert.rejects(db.branch("ghost").get("docs", "1"), (e: ChronosError) => e.status === 404);
// time travel: read the past, see history, restore
await db.put("docs", "tt", { v: 1 });
await new Promise((r) => setTimeout(r, 20));
const then = (await db.sql<{ t: string }>("select now()::text as t")).rows[0].t;
await new Promise((r) => setTimeout(r, 20));
await db.put("docs", "tt", { v: 2 });
assert.equal((await db.at(then).get<{ v: number }>("docs", "tt"))?.v, 1);
assert.equal((await db.history(5))[0].event, "write");
assert((await db.restore(then)) >= 1);
assert.equal((await db.get<{ v: number }>("docs", "tt"))?.v, 1);
// merge engine: preview, then settle with a pick
await db.put("docs", "m", { a: 1 });
const m = await db.fork("merge-me");
await m.put("docs", "m", { a: 2 });
await db.put("docs", "m", { a: 3 });
const p = await m.preview();
assert.equal(p.conflicts, 1);
assert.equal(await m.merge("fail", { picks: { "docs/m": { a: 4 } } }), 1);
assert.equal((await db.get<{ a: number }>("docs", "m"))?.a, 4);
// merge part of a branch, or into another branch: the branch stays
const part = await db.fork("part-me");
await part.put("docs", "p1", { v: 1 });
await part.put("docs", "p2", { v: 2 });
const other = await db.fork("other");
assert.equal((await part.preview("fail", { onlyKeys: ["docs/p1"] })).rows[0].key, "docs/p1");
assert.equal(await part.merge("fail", { into: "other", onlyKeys: ["docs/p2"] }), 1);
assert.equal((await other.get<{ v: number }>("docs", "p2"))?.v, 2);
assert.equal(await part.merge("fail", { onlyKeys: ["docs/p1"] }), 1);
assert.equal(await db.get("docs", "p2"), null);
assert.deepEqual((await part.diff()).map((c) => c.key), ["docs/p2"]);
assert.equal(await part.merge(), 1);
await other.discard();

// simulate: many worlds, the best kept; replay one from history
await db.sql("create table stock (id integer primary key, qty integer)");
await db.sql("insert into stock values (1, 10), (2, 20)");
const sim = await db.simulate(8, "try", "update stock set qty = qty + floor(random() * 10) + $1", "select sum(qty) from stock", { keep: 2, seed: 7 });
assert.equal(sim.worlds.length, 8);
assert.deepEqual(sim.worlds.filter((w) => w.kept).map((w) => w.world), sim.worlds.slice(0, 2).map((w) => w.world));
const again = await db.simulate(8, "try2", "update stock set qty = qty + floor(random() * 10) + $1", "select sum(qty) from stock", { keep: 2, seed: 7 });
assert.deepEqual(again.worlds.map((w) => w.score), sim.worlds.map((w) => w.score));
assert.equal((await db.replay(sim.worlds[0].world)).identical, true);
console.log("typescript client: ok");
