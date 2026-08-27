import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("live refresh workflow is off-minute, serialized, bounded, and never force-pushes", async () => {
  const yaml = await fs.readFile(new URL("../.github/workflows/public-feed-live-refresh.yml", import.meta.url), "utf8");
  assert.match(yaml, /cron:\s*["']7,22,37,52 \* \* \* \*["']/);
  assert.match(yaml, /concurrency:\s*\n\s+group: public-feed-main\s*\n\s+cancel-in-progress: false/);
  assert.match(yaml, /timeout-minutes: 10/);
  assert.match(yaml, /git push origin HEAD:main/);
  assert.match(yaml, /non-fast-forward/);
  assert.match(yaml, /git rebase origin\/main/);
  assert.match(yaml, /schannel\|ssl\|tls/);
  assert.doesNotMatch(yaml, /git push[^\n]*--force/);
  assert.doesNotMatch(yaml, /git push[^\n]*-f\b/);
});
