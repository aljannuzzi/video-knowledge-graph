import test from "node:test";
import assert from "node:assert/strict";
import { runtimeGrantStatement } from "./bootstrap-statements.js";

test("SQL runtime bootstrap uses explicit Entra SID and schema-scoped data grants", () => {
  const sql = runtimeGrantStatement("video-kg-runtime", "11111111-2222-4333-8444-555555555555");
  assert.match(sql, /CREATE USER \[video-kg-runtime\] WITH SID/);
  assert.match(sql, /TYPE = E/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::vkg/);
  assert.doesNotMatch(sql, /PASSWORD|FROM EXTERNAL PROVIDER|ALTER ROLE|CONTROL DATABASE|GRANT ALTER/);
});
test("SQL runtime bootstrap refuses mismatched identities and injected principal values", () => {
  const sql = runtimeGrantStatement("runtime", "11111111-2222-4333-8444-555555555555");
  assert.match(sql, /sid <> @sid OR type <> 'E'/);
  for (const value of ["dbo]; DROP TABLE vkg.Nodes;--", "", "a'b", "name with spaces"]) {
    assert.throws(() => runtimeGrantStatement(value, "11111111-2222-4333-8444-555555555555"));
  }
  assert.throws(() => runtimeGrantStatement("runtime", "11111111-2222-4333-8444-555555555555';"));
});
