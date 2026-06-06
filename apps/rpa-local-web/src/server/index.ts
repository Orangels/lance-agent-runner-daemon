import { readRpaLocalServerConfig } from './config.js';
import { createRpaLocalServer } from './server.js';

const config = readRpaLocalServerConfig();
const app = await createRpaLocalServer({ config });

app.listen(config.port, config.host, () => {
  console.log(`RPA Local Web listening on http://${config.host}:${config.port}`);
});
