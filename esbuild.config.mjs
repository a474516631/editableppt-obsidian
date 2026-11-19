import { builtinModules, createRequire } from 'node:module';
import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const require = createRequire(import.meta.url);

// Modules that must not reach the bundle, and what stands in for each.
const STUBS = {
  // pptxgenjs reads files and URLs through Node when it can. Images reach it
  // as data URLs, so those paths are never taken.
  'node:fs': 'export default undefined; export const promises = undefined;',
  'node:https': 'export default undefined;',
  // JSZip's Node stream support; without it JSZip reports streams as unavailable.
  'readable-stream': 'module.exports = {};',
  // JSZip's polyfills for browsers without Promise or setImmediate. Both can
  // create script elements. Promise always exists here, and src/set-immediate.ts
  // is injected for setImmediate.
  lie: 'module.exports = Promise;',
  setimmediate: '',
};

const leanDependencies = {
  name: 'lean-dependencies',
  setup(build) {
    // For browsers JSZip resolves to a prebuilt file with its polyfills baked
    // in. Its source is bundled instead, so they can be left out.
    build.onResolve({ filter: /^jszip$/ }, () => ({
      path: require.resolve('jszip/lib/index.js'),
    }));
    const names = Object.keys(STUBS).join('|');
    build.onResolve({ filter: new RegExp(`^(${names})$`) }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: STUBS[args.path],
    }));
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
    ...builtinModules,
  ],
  plugins: [leanDependencies],
  inject: ['src/set-immediate.ts'],
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  minify: production,
  outfile: 'main.js',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
