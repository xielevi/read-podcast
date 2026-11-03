import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	build: {
		command: "node scripts/build_frontend.mjs",
		watchDir: "public/js",
	},
	assetsDirectory: "./public",
});
