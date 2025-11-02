/* eslint-disable no-console */
import { run } from "./function";

async function main() {
  try {
    const configEnv = process.env.CONFIG;
    if (!configEnv) {
      console.error("❌ Missing CONFIG environment variable.");
      process.exit(1);
    }

    let config: any;
    try {
      config = JSON.parse(configEnv);
    } catch (e) {
      console.error("❌ CONFIG is not valid JSON:", e);
      process.exit(1);
    }

    const users = Array.isArray(config?.users) ? config.users : [];
    if (users.length === 0) {
      console.error("❌ CONFIG has no users defined.");
      process.exit(1);
    }

    for (const user of users) {
      if (!user?.apiKey || typeof user.apiKey !== "string" || user.apiKey.trim() === "") {
        throw new Error(
          "CONFIG.users[].apiKey is required. Each user must provide their own Immich API key."
        );
      }

      const links = Array.isArray(user.personLinks) ? user.personLinks : [];
      if (links.length === 0) {
        console.warn("⚠️  User has no personLinks; skipping user.");
        continue;
      }

      for (const link of links) {
        if (!link?.personId || !link?.albumId) {
          console.warn("⚠️  Skipping link with missing personId/albumId:", link);
          continue;
        }
        const description =
          link.description ?? `${link.personId} → ${link.albumId}`;
        console.log(`=== ${description} ===`);
        await run({ ...link, apiKey: user.apiKey }); // ← critical: pass per-user key into run()
      }
    }

    console.log("✅ Completed all configured person-album tasks.");
  } catch (err) {
    console.error("💥 Fatal error in main():", err);
    process.exit(1);
  }
}

main();
