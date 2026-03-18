const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'watch-log',
        setup(build) {
          build.onEnd(result => {
            if (result.errors.length) {
              console.error('Build failed:', result.errors);
            } else {
              console.log('[esbuild] Build finished');
            }
          });
        },
      },
    ],
  });
  if (watch) {
    await ctx.watch();
    console.log('[esbuild] Watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
