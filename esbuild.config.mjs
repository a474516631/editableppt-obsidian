import { builtinModules } from 'node:module';
import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

// pptxgenjs reads files and URLs through Node when it can. Images reach it as
// data URLs, so those paths are never taken; stubbing the modules keeps Node
// APIs out of a bundle that also runs on mobile.
const noNodeModules = {
  name: 'no-node-modules',
  setup(build) {
    build.onResolve({ filter: /^node:(fs|https)$/ }, (args) => ({
      path: args.path,
      namespace: 'node-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents: 'export default undefined; export const promises = undefined;',
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
  plugins: [noNodeModules],
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
