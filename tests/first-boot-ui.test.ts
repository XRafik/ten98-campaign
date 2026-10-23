import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';
import { WorkspaceOnboarding } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';

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

test('the first-project step is WorkspaceOnboarding naming a project, with the sample opt-in in its form', async () => {
  const step = /  if \(firstProjectWorkspace\) return (<WorkspaceOnboarding .+\/>);\n/.exec(source)?.[1];
  assert.ok(step, 'The first-project step uses the library onboarding flow.');
  const { code } = await transformWithOxc(`const element = ${step};`, 'FirstProject.tsx', { jsx: { runtime: 'classic' } });
  const created: unknown[] = []; let signedOut = 0;
  const element = new Function('React', 'Brand', 'WorkspaceOnboarding', 'firstProjectWorkspace', 'state', 'error', 'busy', 'createFirstProject', 'signOut', code + '; return element;')(
    React, AppBrand, WorkspaceOnboarding, { id: 'w1', name: 'Owner team', role: 'owner' }, { user: { email: 'owner@example.test' } }, '', false,
    (workspaceId: string, values: unknown) => { created.push([workspaceId, values]); }, () => { signedOut++; });
  assert.equal(element.type, WorkspaceOnboarding);
  assert.equal(element.props.email, 'owner@example.test'); assert.equal(element.props.title, 'Owner team');
  assert.equal(element.props.subheading, 'Create your first project'); assert.equal(element.props.nameLabel, 'Project name'); assert.equal(element.props.submitLabel, 'Create project');
  assert.deepEqual(element.props.sampleOptIn, { label: 'Add sample data' });
  element.props.onSubmit({ name: 'Spring launch', sample: true }); element.props.onSubmit({ name: 'Own work', sample: false });
  assert.deepEqual(created, [['w1', { name: 'Spring launch', sample: true }], ['w1', { name: 'Own work', sample: false }]]);
  element.props.signOut.onClick(); assert.equal(signedOut, 1);
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
