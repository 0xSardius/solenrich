import { app } from './lib/agent';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting agent server on port ${port}...`);

export default {
  port,
  hostname: '127.0.0.1',
  fetch: app.fetch,
};
