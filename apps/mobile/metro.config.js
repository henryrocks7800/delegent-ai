// Expo's default Metro config + a tiny resolver patch so the @sidekick/shared
// package's Node-ESM-style ".js" suffixes on relative imports resolve to ".ts"
// source files at bundle time.
//
// Why this exists:
//   packages/shared/src/index.ts re-exports siblings with `import { x } from
//   './foo.js'`. Node ESM (and Vite, which uses Bundler resolution) wants the
//   .js suffix; without it, the worker test suite and the shared package's
//   own dist-run tests fail with ERR_MODULE_NOT_FOUND. Metro's default
//   resolver, however, treats ".js" as part of the filename and tries to find
//   "./foo.js.ts" instead of recognising that the .js is a Node-ESM suffix
//   pointing at a TypeScript source file.
//
// The patch:
//   When a relative import (`./` or `../`) ends in `.js`, strip the suffix
//   before delegating to the default resolver. The default resolver then walks
//   the TS extension list and finds `./foo.ts`. Non-relative imports (npm
//   packages, e.g. `react-native`) keep their suffix untouched.

const { getDefaultConfig } = require('@expo/metro-config');

const config = getDefaultConfig(__dirname);

const previousResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  let resolvedModuleName = moduleName;
  if ((moduleName.startsWith('./') || moduleName.startsWith('../')) && moduleName.endsWith('.js')) {
    resolvedModuleName = moduleName.slice(0, -'.js'.length);
  }
  if (previousResolveRequest) {
    return previousResolveRequest(context, resolvedModuleName, platform);
  }
  return context.resolveRequest(context, resolvedModuleName, platform);
};

module.exports = config;
