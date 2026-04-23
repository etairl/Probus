import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';
import { loadDotenv } from './env.js';
import { parseArgs, HELP_TEXT } from './cli.js';
import { shutdownOpencode } from './opencode.js';

loadDotenv();

const parsed = parseArgs(process.argv.slice(2));

const shutdown = () => {
  shutdownOpencode().catch(() => { /* ignore */ }).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { void shutdownOpencode(); });

switch (parsed.kind) {
  case 'help':
    console.log(HELP_TEXT);
    process.exit(0);
  case 'error':
    console.error(parsed.message);
    process.exit(1);
  case 'view':
    render(<App targetRepo={parsed.repo} researcherModel={null} qaModel={null} mode="view" />);
    break;
  case 'scan':
    render(
      <App
        targetRepo={parsed.repo}
        researcherModel={parsed.researcherModel}
        qaModel={parsed.qaModel}
        effort={parsed.effort}
        preferredProvider={parsed.preferredProvider}
        parallel={parsed.parallel}
      />,
    );
    break;
}
