import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
import {createModuleFederationConfig, pluginModuleFederation} from '@module-federation/rsbuild-plugin';
import ConcatenatePlugin from './ConcatenatePlugin.ts';

// MF naming contract: `name` must equal the ui_schema element's `scope` and
// the exposed key its `module` (src/sia_local_control_ui/app_ui.py,
// pinned by tests/test_widget_contract.py).
const mfConfig = createModuleFederationConfig({
    name: 'SiaHmiWidget',
    remotes: {
        // The actual URLs are injected by the host at runtime
        // (window.dooverAdminSite_remoteUrl / window.dooverCustomerSite_remoteUrl);
        // the device agent's widget host installs compatibility containers
        // under the same names.
        doover_admin: 'doover_admin@[window.dooverAdminSite_remoteUrl]',
        customer_site: 'customer_site@[window.dooverCustomerSite_remoteUrl]',
    },
    exposes: {
        './SiaHmiWidget': './src/SiaHmiWidget',
    },
    shared: {
        react: {singleton: true, requiredVersion: '^18.3.1', eager: true},
        'react-dom': {singleton: true, requiredVersion: '^18.3.1', eager: true},
        'react-router': {singleton: true, requiredVersion: false, eager: true},
        'doover-js': {singleton: true, eager: true, requiredVersion: false},
        'doover-js/react': {singleton: true, eager: true, requiredVersion: false},
        '@tanstack/react-query': {singleton: true, eager: true, requiredVersion: false},
    },
});

export default defineConfig({
    tools: {
        rspack: {
            plugins: [
                new ConcatenatePlugin({
                    source: './dist',
                    destination: './assets',
                    name: 'SiaHmiWidget.js',
                    ignore: ['main.js'],
                }),
            ],
        },
    },
    output: {
        injectStyles: true,
        // Never emit a separate asset file: the platform serves ONE .js.
        dataUriLimit: Number.MAX_SAFE_INTEGER,
    },
    plugins: [
        pluginReact(),
        pluginModuleFederation(mfConfig),
    ],
    performance: {
        chunkSplit: {
            strategy: 'all-in-one',
        },
    },
});
