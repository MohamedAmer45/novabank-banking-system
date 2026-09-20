/*
 * Vercel serverless entry point. Vercel invokes the default export with the
 * same (req, res) pair a Node http server would, so the router is reused
 * unchanged; server.js is only the long-lived local/CI wrapper around it.
 */
import { handleRequest } from '../src/app.js';

export default handleRequest;
