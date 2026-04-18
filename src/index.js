require("dotenv").config();

const http = require("http");
const app = require("./app");
const { connectDb } = require("./config/db");
const { initWebsocket } = require("./services/websocket.service");
const photoMaintenance = require("./services/photoMaintenance.service");

const PORT = process.env.PORT || 3000;

const rawStoryPurgePollMs = Number(process.env.STORY_MEDIA_PURGE_POLL_MS);
const STORY_MEDIA_PURGE_POLL_MS =
  Number.isFinite(rawStoryPurgePollMs) && rawStoryPurgePollMs >= 60_000 ? rawStoryPurgePollMs : 3_600_000;

function scheduleStoryMediaPurge() {
  const tick = () => {
    photoMaintenance.purgeDueStoryMedia().catch((e) => {
      console.error("[story-media-purge]", e && e.message ? e.message : e);
    });
  };
  setTimeout(tick, 15_000);
  setInterval(tick, STORY_MEDIA_PURGE_POLL_MS);
}

async function startServer() {
  try {
    await connectDb();
    console.log("Database Connected");

    scheduleStoryMediaPurge();

    const server = http.createServer(app);
    initWebsocket(server);
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
