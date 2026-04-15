require("dotenv").config();

const app = require("./app");
const { connectDb } = require("./config/db");

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await connectDb();
    console.log("Database Connected");

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
