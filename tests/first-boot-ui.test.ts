import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { Button, Checkbox, PageHeader, SettingsPanel, Stack } from '@ten98/ui';
import { AppBrand, AppField } from '@ten98/ui/app';

const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const slice = (from: string, to: string) => { const start = source.indexOf(from); assert.ok(start > -1, `${from} is missing`); return source.slice(start, source.indexOf(to, start)); };

test('after the first sign-up an owner or administrator without projects lands on the first-project step', () => {
  const expression = /const firstProjectWorkspace = (.+?);\n/.exec(source)?.[1];
  assert.ok(expression, 'The app routes a workspace without projects to the first-project step.');
  const pick = new Function('state', `return ${expression};`);
  const owner = { id: 'w1', name: 'Owner team', role: 'owner' };
  assert.equal(pick({ projects: [], workspaces: [owner] }), owner);
  assert.equal(pick({ projects: [], workspaces: [{ id: 'w2', name: 'Shared', role: 'editor' }, { ...owner, role: 'admin' }] }).id, 'w1');
  assert.ok(!pick({ projects: [], workspaces: [{ id: 'w2', name: 'Shared', role: 'editor' }] }), 'Members who cannot add the sample keep workspace onboarding.');
  assert.ok(!pick({ projects: [{ id: 'p1' }], workspaces: [owner] }));
  assert.ok(source.indexOf('if (firstProjectWorkspace)') < source.indexOf('if (!state.projectId || !project) return <WorkspaceOnboarding'));
});

test('the first-project step names the project, offers the sample checked by default and submits the opt-in', async () => {
  const { code } = await transformWithOxc(slice('function FirstProject(', '\n// Campaign adapter'), 'FirstProject.tsx', { jsx: { runtime: 'classic' } });
  const FirstProject = new Function('React', 'Brand', 'PageHeader', 'SettingsPanel', 'Button', 'Field', 'Checkbox', 'Stack', code + '; return FirstProject;')(React, AppBrand, PageHeader, SettingsPanel, Button, AppField, Checkbox, Stack);
  const created: unknown[] = []; let signedOut = 0;
  const screen = FirstProject({ email: 'owner@example.test', workspaceName: 'Owner team', busy: false, onCreate: (values: unknown) => created.push(values), onSignOut: () => { signedOut++; } });
  const html = renderToStaticMarkup(screen);
  assert.match(html, /<h1[^>]*>Create your first project<\/h1>/);
  assert.match(html, /Signed in as owner@example\.test/); assert.match(html, /Owner team/);
  assert.match(html, /name="name"[^>]*required|required[^>]*name="name"/);
  assert.match(html, /name="sample"[^>]*checked|checked[^>]*name="sample"/);
  assert.match(html, />Create project</); assert.match(html, />Sign out</);
  const panel = React.Children.toArray(screen.props.children).find((child: any) => child.type === SettingsPanel) as any;
  const form = new FormData(); form.set('name', 'Spring launch'); form.set('sample', 'true');
  panel.props.onSubmit(form); form.delete('sample'); panel.props.onSubmit(form);
  assert.deepEqual(created, [{ name: 'Spring launch', sample: true }, { name: 'Spring launch', sample: false }]);
  panel.props.actions.props.onClick(); assert.equal(signedOut, 1);
});

test('creating the first project posts the opt-in to the workspace and opens the new project once', async () => {
  const calls: unknown[][] = [], opened: string[] = [], pendingWork = { current: 0 };
  const context = { pendingWork, run: async (work: () => Promise<unknown>) => { pendingWork.current++; try { return await work(); } finally { pendingWork.current--; } }, api: async (...args: unknown[]) => { calls.push(args); return { project: { id: 'project-1' } }; }, reload: async (id: string) => { opened.push(id); } };
  const create = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(slice('async function createFirstProject(', '  async function createWorkspace('))});`)(...Object.values(context));
  await create('workspace-1', { name: 'Spring launch', sample: true });
  assert.deepEqual(calls, [['/projects', 'POST', { workspaceId: 'workspace-1', name: 'Spring launch', sample: true }]]);
  assert.deepEqual(opened, ['project-1']);
  pendingWork.current = 1; await create('workspace-1', { name: 'Spring launch', sample: true });
  assert.equal(calls.length, 1, 'An in-flight action must not create a second project.');
});
