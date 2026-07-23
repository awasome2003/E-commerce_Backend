import "dotenv/config";
import { validateConfig } from "./lib/config.js";

// Fail fast on bad config before importing the app / connecting anything.
validateConfig();

const { default: app } = await import("./app.js");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}/api`);
});
