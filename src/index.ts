///<reference path="./types.d.ts" />

import { logger } from './utils';
import minimist from 'minimist';
import { scrapeErrors } from './scrapeErrors';

const argv = minimist(process.argv.slice(2), {
  string: [
    'accountId',
  ]
});

async function app(argv: any) {
  await scrapeErrors(argv);
}

const startTime = Date.now();
app(argv)
  .then(() => {
    logger.log(
      `Successfully ran scrape in [${Date.now() -
      startTime}ms]`
    );
  })
  .catch(err => {
    logger.error(`Failed to scrape after [${Date.now() - startTime}ms]:`, err);
  });
