import {createApiServer} from './server.js';


createApiServer().listen(Number.parseInt(process.env.API_PORT ?? '3000', 10));
