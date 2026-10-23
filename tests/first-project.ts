import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type App = { server: Server; config: { appUrl: string } };
type Setup = { status: number; data: { workspaceId?: string }; cookie?: string | null };

/**
 * Owner setup creates only the named workspace; the first project is the app's next step. Fixtures that need a project
 * create it through POST /api/projects, as that step does. node:http keeps it independent of tests that mock fetch.
 */
export async function firstProject(app: App, setup: Setup, options: { name?: string; sample?: boolean; cookie?: string } = {}): Promise<string> {
  // Fixtures with a cookie jar pass the owner's session cookie; others carry it on the setup response.
  const cookie = options.cookie ?? setup.cookie;
  if (setup.status !== 201 || !setup.data.workspaceId || !cookie) throw new Error(`Owner setup did not succeed (${setup.status}).`);
  const body = JSON.stringify({ workspaceId: setup.data.workspaceId, name: options.name ?? 'Brand launch', sample: options.sample ?? false });
  return new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, path: '/api/projects', method: 'POST', headers: { Origin: app.config.appUrl, Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => response.statusCode === 201 ? resolve(JSON.parse(text).project.id) : reject(new Error(`First project creation failed (${response.statusCode}): ${text}`)));
    });
    sent.on('error', reject);
    sent.end(body);
  });
}
