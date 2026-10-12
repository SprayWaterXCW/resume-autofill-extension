import { build } from "esbuild";

await build({
  entryPoints: ["agent-extension/src/worker.js"],
  outfile: "agent-extension/dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  legalComments: "none",
  logLevel: "info",
});

await build({
  entryPoints: ["agent-extension/src/real-page-entry.js"],
  outfile: "agent-extension/dist/real-page.js", bundle: true, format: "iife",
  platform: "browser", target: "chrome116", legalComments: "none", logLevel: "info",
});

await build({
  entryPoints: ["agent-extension/src/profile-editor-entry.js"],
  outfile: "agent-extension/dist/profile-editor.js", bundle: true, format: "iife",
  platform: "browser", target: "chrome116", legalComments: "none", logLevel: "info",
});
