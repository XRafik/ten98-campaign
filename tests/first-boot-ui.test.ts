import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { AccountMenu, AppShell, AppTopbar, Button, EmptyState, PageHeader, WorkspaceOnboarding } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';

const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const slice = (from: string, to: string) => { const start = source.indexOf(from); assert.ok(start > -1, `${from} is missing`); return source.slice(start, source.indexOf(to, start)); };

// FirstProject with its one useState replaced, so each test chooses the skipped state and sees the requested change.
const { code: firstProjectCode } = await transformWithOxc(slice('function FirstProject(', '\n// Campaign adapter'), 'FirstProject.tsx', { jsx: { runtime: 'classic' } });
function firstProject(skipped: boolean) {
  const changes: boolean[] = [], created: unknown[] = []; let signedOut = 0;
  const FirstProject = new Function('React', 'useState', 'Brand', 'WorkspaceOnboarding', 'Button', 'AppShell', 'AppTopbar', 'AccountMenu', 'PageHeader', 'EmptyState', firstProjectCode + '; return FirstProject;')(
    React, () => [skipped, (next: boolean) => { changes.push(next); }], AppBrand, WorkspaceOnboarding, Button, AppShell, AppTopbar, AccountMenu, PageHeader, EmptyState);
  const element = FirstProject({ workspaceName: 'My workspace', user: { id: 'u1', name: 'Owner', email: 'owner@example.test' }, busy: false, onCreate: (values: unknown) => { created.push(values); }, onSignOut: () => { signedOut++; } });
  return { element, changes, created, signedOut: () => signedOut };
}

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

test('the first-project step is one project name, the sample opt-in and Skip for now', () => {
  const { element, changes, created } = firstProject(false);
  assert.equal(element.type, WorkspaceOnboarding);
  assert.equal(element.props.subheading, 'Create your first project'); assert.equal(element.props.nameLabel, 'Project name'); assert.equal(element.props.submitLabel, 'Create project');
  assert.deepEqual(element.props.sampleOptIn, { label: 'Add sample data' });
  assert.equal(element.props.help, undefined, 'No extra explanation text.'); assert.equal(element.props.signOut, undefined);
  const html = renderToStaticMarkup(element);
  assert.match(html, />Create project</); assert.match(html, />Skip for now</);
  element.props.onSubmit({ name: 'Spring launch', sample: true }); element.props.onSubmit({ name: 'Own work' });
  assert.deepEqual(created, [{ name: 'Spring launch', sample: true }, { name: 'Own work', sample: false }]);
  const skip = element.props.children;
  assert.equal(skip.type, Button); assert.equal(skip.props.variant, 'secondary'); assert.equal(skip.props.children, 'Skip for now');
  skip.props.onClick(); assert.deepEqual(changes, [true]);
});

test('skipping lands in the app with no project: an Overview empty state offers Create project', () => {
  const { element, changes, signedOut } = firstProject(true);
  assert.equal(element.type, AppShell);
  const html = renderToStaticMarkup(element);
  assert.match(html, /<h1[^>]*>Overview<\/h1>/); assert.match(html, /No project yet/); assert.match(html, />Create project</);
  const empty = React.Children.toArray(element.props.children).find((child: any) => child.type === EmptyState) as any;
  empty.props.action.props.onClick(); assert.deepEqual(changes, [false], 'Create project returns to the first-project step.');
  const menu = element.props.topbar.props.actions;
  menu.props.items.find((item: { id: string }) => item.id === 'sign-out').onSelect(); assert.equal(signedOut(), 1);
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
