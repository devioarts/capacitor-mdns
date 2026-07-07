const external = ['bonjour-service', 'electron'];

export default [
  {
    input: 'electron/build/electron/src/index.js',
    output: {
      file: 'electron/dist/plugin.cjs.js',
      format: 'cjs',
      sourcemap: true,
    },
    external,
  },
  {
    input: 'electron/build/electron/src/plugin-settings.js',
    output: {
      file: 'electron/dist/plugin-settings.js',
      format: 'cjs',
      sourcemap: true,
    },
    external,
  },
];
