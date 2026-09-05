import { createServer, type ServerResponse } from 'node:http';

const port = Number(process.env.ORCHESTRATOR_PORT ?? 8787);
const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': clientOrigin,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok', service: 'wingman-orchestrator' });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`Wingman orchestrator listening on http://localhost:${port}`);
});
