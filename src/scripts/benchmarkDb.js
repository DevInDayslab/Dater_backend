require("dotenv").config();

const { Client } = require("pg");
const { performance } = require("perf_hooks");

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const TEST_TARGET_ID = "00000000-0000-0000-0000-000000000002";

async function runLoop(client, label, queryText, values, iterations = 200) {
  const timings = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await client.query(queryText, values);
    const t1 = performance.now();
    timings.push(t1 - t0);
  }

  timings.sort((a, b) => a - b);
  const sum = timings.reduce((acc, t) => acc + t, 0);
  const avg = sum / timings.length;
  const p50 = timings[Math.floor(timings.length * 0.5)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  const p99 = timings[Math.floor(timings.length * 0.99)];

  return {
    label,
    iterations,
    avg_ms: Number(avg.toFixed(3)),
    p50_ms: Number(p50.toFixed(3)),
    p95_ms: Number(p95.toFixed(3)),
    p99_ms: Number(p99.toFixed(3)),
  };
}

async function runExplain(client, label, queryText, values) {
  const res = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queryText}`,
    values
  );
  const plan = res.rows[0]["QUERY PLAN"][0];
  return {
    label,
    execution_ms: Number(plan["Execution Time"].toFixed(3)),
    planning_ms: Number(plan["Planning Time"].toFixed(3)),
    top_node: plan.Plan["Node Type"],
  };
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const ping = await runLoop(client, "db_ping_select_1", "SELECT 1", [], 200);

  const feedQuery = `
    SELECT target_id
    FROM user_interactions
    WHERE user_id = $1
      AND target_id = $2
      AND (
        (interaction_type IN ('IGNORE', 'VIEWED') AND expires_at > NOW())
        OR
        (interaction_type IN ('REQUEST', 'COMMENT_REQUEST') AND request_status = 'IGNORED')
      )
    LIMIT 1
  `;

  const storyQuery = `
    SELECT id
    FROM stories
    WHERE user_id = $1
      AND deleted_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const chatInboxQuery = `
    SELECT cts.thread_id
    FROM chat_thread_user_state cts
    JOIN chat_threads ct ON ct.id = cts.thread_id
    WHERE cts.user_id = $1
      AND cts.is_deleted_from_inbox = FALSE
    ORDER BY cts.pinned_to_bottom ASC, ct.last_message_at DESC
    LIMIT 20
  `;

  const feedLoop = await runLoop(
    client,
    "feed_exclusion_lookup",
    feedQuery,
    [TEST_USER_ID, TEST_TARGET_ID],
    200
  );
  const storyLoop = await runLoop(
    client,
    "active_story_fetch",
    storyQuery,
    [TEST_USER_ID],
    200
  );
  const chatLoop = await runLoop(
    client,
    "chat_inbox_fetch",
    chatInboxQuery,
    [TEST_USER_ID],
    200
  );

  const explainFeed = await runExplain(
    client,
    "explain_feed_exclusion_lookup",
    feedQuery,
    [TEST_USER_ID, TEST_TARGET_ID]
  );
  const explainStory = await runExplain(
    client,
    "explain_active_story_fetch",
    storyQuery,
    [TEST_USER_ID]
  );
  const explainChat = await runExplain(
    client,
    "explain_chat_inbox_fetch",
    chatInboxQuery,
    [TEST_USER_ID]
  );

  console.log(
    JSON.stringify(
      {
        benchmark_note:
          "Baseline read-only benchmark on current dataset size; not a concurrent load test.",
        loops: [ping, feedLoop, storyLoop, chatLoop],
        explain: [explainFeed, explainStory, explainChat],
      },
      null,
      2
    )
  );

  await client.end();
}

main().catch((error) => {
  console.error("Benchmark failed:", error.message);
  process.exit(1);
});
