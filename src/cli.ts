import { defineCommand, runMain } from 'citty';

const main = defineCommand({
  meta: {
    name: 'alfred',
    description: 'Development butler for Claude Code',
  },
  subCommands: {
    version: defineCommand({
      meta: { description: 'Show version' },
      run() {
        // Will read from package.json
        console.log('alfred 0.1.0-alpha.0');
      },
    }),
  },
  run() {
    console.log('alfred — development butler for Claude Code');
    console.log('Run "alfred --help" for usage.');
  },
});

runMain(main);
