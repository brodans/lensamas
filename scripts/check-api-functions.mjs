import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiRoot = resolve('api');
const entries = await readdir(apiRoot, { withFileTypes: true });
const directRoutes = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => `api/${entry.name}`);
const streamRoutes = entries
  .filter((entry) => entry.isDirectory() && entry.name === 'stream')
  .flatMap(() => ['api/stream/[slug].ts']);

const routes = [...directRoutes, ...streamRoutes].sort();
const limit = 12;
if (routes.length > limit) {
  console.error(`Vercel function budget exceeded: ${routes.length}/${limit}`);
  for (const route of routes) console.error(`- ${route}`);
  process.exit(1);
}
console.log(`Vercel function budget OK: ${routes.length}/${limit}`);
