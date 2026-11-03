import { bindings, defineConfig, exports, triggers } from "cf/config";
import { readFileSync } from "node:fs";
import { parseJsonc } from "./scripts/setup.mjs";

// Shared resource names and defaults keep Workers Builds and cf deployments aligned.
const source = parseJsonc(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"));

export default defineConfig(({ mode }) => {
  const production = mode === "production";
  if (production && !process.env.READ_PODCAST_CF_DEPLOY) {
    throw new Error("Use npm run deploy:production to load deployment values.");
  }
  const deployment = production ? JSON.parse(process.env.READ_PODCAST_CF_DEPLOY!) : null;
  return {
    worker: {
      name: source.name,
      compatibilityDate: source.compatibility_date,
      entrypoint: source.main,
      workersDev: source.workers_dev,
      domains: deployment ? [deployment.domain] : [],
      previewUrls: source.preview_urls,
      observability: source.observability,
      assets: {
        notFoundHandling: source.assets.not_found_handling,
        runWorkerFirst: source.assets.run_worker_first,
      },
      triggers: source.triggers.crons.map((schedule: string) => triggers.scheduled({ schedule })),
      env: {
        ...Object.fromEntries(Object.entries(source.vars).map(([key, value]) => [key, bindings.text(value as string)])),
        ...Object.fromEntries(Object.entries(deployment?.vars ?? {}).map(([key, value]) => [key, bindings.text(value as string)])),
        DB: bindings.d1({
          name: source.d1_databases[0].database_name,
        }),
        RAW_BUCKET: bindings.r2({
          name: source.r2_buckets[0].bucket_name,
        }),
        PROCESSING_WORKFLOW: bindings.workflow({
          name: source.workflows[0].name,
          worker: source.name,
          exportName: "ProcessingWorkflow",
        }),
        ASSETS: bindings.assets(),
      },
      exports: {
        ProcessingWorkflow: exports.workflow({
          name: source.workflows[0].name,
        }),
      },
    },
  };
});
