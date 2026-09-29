import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
import {createRequire} from 'node:module';

// doover-js is CommonJS, so it `require`s react-query's CJS build while this
// entry imports the ESM one: two copies, two QueryClient contexts. Pin both
// to the one CJS file (the MF build shares a single instance instead).
const reactQuery = createRequire(import.meta.url).resolve('@tanstack/react-query');

// Mock host build (screenshots / manual checks): the real widget component
// rendered with a mock data client, the two `customer_site/*` host modules
// replaced by local stand-ins, and no Module Federation. Output goes to
// mock-host/dist (git-ignored); serve it with any static server.
export default defineConfig({
    plugins: [pluginReact()],
    source: {
        entry: {index: './mock-host/main.tsx'},
    },
    resolve: {
        alias: {
            'customer_site/RemoteComponentWrapper': './mock-host/RemoteComponentWrapper.tsx',
            'customer_site/useRemoteParams': './mock-host/useRemoteParams.ts',
            '@tanstack/react-query$': reactQuery,
        },
    },
    html: {template: './mock-host/index.html'},
    output: {
        distPath: {root: 'mock-host/dist'},
        assetPrefix: './',
        injectStyles: true,
        dataUriLimit: Number.MAX_SAFE_INTEGER,
    },
});
