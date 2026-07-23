import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import {
  createModuleFederationConfig,
  pluginModuleFederation,
} from "@module-federation/rsbuild-plugin";

import ConcatenatePlugin from "./ConcatenatePlugin";

const mfConfig = createModuleFederationConfig({
  name: "SiaHmiWidget",
  remotes: {
    doover_admin: "doover_admin@[window.dooverAdminSite_remoteUrl]",
    customer_site: "customer_site@[window.dooverCustomerSite_remoteUrl]",
  },
  exposes: {
    "./SiaHmiWidget": "./src/SiaHmiWidget",
  },
  shared: {
    react: { singleton: true, requiredVersion: "^18.3.1", eager: true },
    "react-dom": { singleton: true, requiredVersion: "^18.3.1", eager: true },
    "react-router": { singleton: true, requiredVersion: false, eager: true },
    "doover-js": { singleton: true, eager: true, requiredVersion: false },
    "doover-js/react": { singleton: true, eager: true, requiredVersion: false },
    "@tanstack/react-query": { singleton: true, eager: true, requiredVersion: false },
  },
});

export default defineConfig({
  tools: {
    rspack: {
      plugins: [
        new ConcatenatePlugin({
          source: "./dist",
          destination: "./assets",
          name: "SiaHmiWidget.js",
          ignore: ["main.js"],
        }),
      ],
    },
  },
  output: { injectStyles: true },
  plugins: [pluginReact(), pluginModuleFederation(mfConfig)],
  performance: { chunkSplit: { strategy: "all-in-one" } },
});
