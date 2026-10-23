import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';
import { resolveVariant, validatePostForPlatforms } from '../shared/social-posts.ts';
import { firstProject } from './first-project.ts';

test('Drive HTTP sync and upload preserve publishing metadata, validate complete batches and atomically deduplicate concurrent imports', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-dam-workflows-')), origin = 'http://127.0.0.1:3000', { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = await testApp(t, { dataDir, appUrl: origin, env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'fixture@example.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), ZERNIO_API_KEY: 'mock-dam-zernio-key' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, originalFetch = globalThis.fetch, writes = []; let cookie, mode = 'valid', uploadMode = 'valid';
  const image = { id: 'drive-image', name: 'Campaign image', mimeType: 'image/png', size: '2048', modifiedTime: '2026-10-18T10:00:00Z', md5Checksum: '1'.repeat(32), imageMediaMetadata: { width: 1080, height: 1350, location: { latitude: 25, longitude: 55 }, cameraMake: 'PRIVATE_EXIF_CAMERA' } };
  const video = { id: 'drive-video', name: 'Campaign video', mimeType: 'video/mp4', size: '4096', videoMediaMetadata: { width: 1080, height: 1920, durationMillis: '15050' } };
  const document = { id: 'drive-document', name: 'Brief', mimeType: 'application/pdf' };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(options.redirect, 'error'); let result;
    if (url.hostname === 'oauth2.googleapis.com') {
      const [header, claims, signature] = new URLSearchParams(options.body).get('assertion').split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/drive'); result = { access_token: 'PRIVATE_GOOGLE_TOKEN' };
    } else if (url.hostname === 'www.googleapis.com') {
      assert.equal(options.headers.Authorization, 'Bearer PRIVATE_GOOGLE_TOKEN');
      if (url.pathname === '/drive/v3/files/folder-fixture') result = { id: 'folder-fixture', mimeType: 'application/vnd.google-apps.folder', driveId: 'shared-drive' };
      else {
        const fields = url.searchParams.get('fields'); assert.ok(fields.includes('imageMediaMetadata(width,height)')); assert.ok(fields.includes('videoMediaMetadata(width,height,durationMillis)')); assert.equal(fields.includes('location'), false);
        if (url.pathname === '/upload/drive/v3/files') {
          assert.equal(options.method, 'POST'); assert.ok(Buffer.isBuffer(options.body)); writes.push({ upload: true });
          result = uploadMode === 'invalid' ? { id: 'uploaded-invalid', name: 'Uploaded', mimeType: 'video/mp4', size: '-1' } : { ...video, id: 'drive-upload', name: 'Upload.mp4' };
        } else {
          assert.equal(url.pathname, '/drive/v3/files'); assert.equal(url.searchParams.get('q'), "'folder-fixture' in parents and trashed = false");
          if (mode === 'invalid') result = { files: [{ ...image, id: 'would-be-partial' }, { ...video, size: '-1' }] };
          else if (mode === 'incomplete') result = { files: [image], incompleteSearch: true };
          else if (mode === 'repeating-page') result = { files: [image], nextPageToken: 'same-page' };
          else if (mode === 'invalid-id') result = { files: [image, { ...video, id: '../invalid' }] };
          else if (mode === 'oversized') result = { files: [{ ...image, size: '9007199254740992' }] };
          else if (mode === 'oversized-page') result = { files: Array(101).fill(image) };
          else if (mode === 'atomic-failure') result = { files: [{ ...image, id: 'atomic-a' }, { ...image, id: 'atomic-b' }] };
          else if (!url.searchParams.get('pageToken')) result = { files: [image, image], nextPageToken: 'second-page' };
          else { assert.equal(url.searchParams.get('pageToken'), 'second-page'); result = { files: [video, document, { id: 'nested-folder', name: 'Nested folder', mimeType: 'application/vnd.google-apps.folder' }] }; }
        }
      }
    } else {
      assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer mock-dam-zernio-key');
      if (url.pathname === '/api/v1/accounts') result = { accounts: [{ _id: 'account-dam', profileId: 'profile-dam', platform: 'facebook', isActive: true }] };
      else if (url.pathname === '/api/v1/tools/validate/post') result = { valid: true, warnings: [] };
      else if (url.pathname === '/api/v1/posts') { const payload = JSON.parse(options.body); writes.push(payload); result = { post: { _id: 'remote-dam-post', ...payload, status: 'published', platforms: payload.platforms.map(copy => ({ ...copy, status: 'published' })) } }; }
      else throw new Error('Unexpected provider endpoint: ' + url.pathname);
    }
    return new Response(JSON.stringify(result));
  };
  async function request(path, method = 'GET', body, key) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'DAM fixture', email: 'dam@example.test', password: 'a sufficiently long fixture password' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
    const state = (await request('/api/state')).data, project = `/api/projects/${state.projectId}`, path = project + '/integrations/drive';
    assert.equal((await request(project, 'PATCH', { driveFolderId: 'folder-fixture', zernioProfileId: 'profile-dam' })).status, 200);
    const results = await Promise.all([request(path + '/sync', 'POST', {}), request(path + '/sync', 'POST', {})]);
    for (const result of results) { assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.synced, 3); assert.equal(JSON.stringify(result.data).includes('PRIVATE_'), false); assert.equal(JSON.stringify(result.data).includes('latitude'), false); }
    let assets = (await request('/api/state')).data.assets; assert.equal(assets.length, 3); assert.equal(new Set(assets.map(asset => asset.driveId)).size, 3);
    assert.equal((await request(path + '/files')).data.files.length, 3, 'The read-only paginated file list also deduplicates files and excludes folders.');
    let savedImage = assets.find(asset => asset.driveId === image.id), savedVideo = assets.find(asset => asset.driveId === video.id), savedDocument = assets.find(asset => asset.driveId === document.id);
    assert.deepEqual([savedImage.width, savedImage.height, savedImage.size], [1080, 1350, 2048]); assert.deepEqual([savedVideo.width, savedVideo.height, savedVideo.duration], [1080, 1920, 15.05]);
    assert.deepEqual([savedDocument.width, savedDocument.height, savedDocument.duration, savedDocument.size], [null, null, null, null]);
    const custom = { deliveryUrl: 'https://cdn.example.com/campaign.png', description: 'A campaign image with meaningful alternative text.', tags: ['launch'], approval: 'approved' };
    assert.equal((await request(`${project}/assets/${savedImage.id}`, 'PATCH', custom)).status, 200);
    assert.equal((await request(`${project}/assets/${savedImage.id}`, 'PATCH', { approval: 'approved' })).status, 200, 'Changing the delivery URL needs a separate review of the resulting creative.');
    assert.equal((await request(path + '/sync', 'POST', {})).status, 200);
    savedImage = (await request('/api/state')).data.assets.find(asset => asset.id === savedImage.id); for (const [field, value] of Object.entries(custom)) assert.deepEqual(savedImage[field], value);
    const post = (await request(project + '/posts', 'POST', { content: 'Approved Drive creative', platforms: ['facebook'], accounts: ['account-dam'], assetId: savedImage.id })).data.record;
    let result = await request(project + '/integrations/social/publish', 'POST', { postId: post.id }, 'dam-publish-001'); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(writes.at(-1).mediaItems, [{ type: 'image', url: custom.deliveryUrl, mimeType: 'image/png', altText: custom.description, size: 2048 }]);
    const before = (await request('/api/state')).data.assets;
    for (const invalidMode of ['invalid', 'invalid-id', 'oversized', 'oversized-page', 'incomplete', 'repeating-page']) { mode = invalidMode; result = await request(path + '/sync', 'POST', {}); assert.ok([502, 503].includes(result.status), JSON.stringify(result.data)); assert.deepEqual((await request('/api/state')).data.assets, before, invalidMode + ' must not partially modify assets.'); }
    // Drive saves run in their own transaction store, so the failure is injected at the second new asset row instead.
    mode = 'atomic-failure'; await app.sql.run(`CREATE FUNCTION fail_second_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.collection = 'assets' AND (SELECT count(*) FROM records WHERE collection = 'assets' AND project_id = NEW.project_id) >= ${before.length + 1} THEN RAISE EXCEPTION 'Simulated storage failure after an insert'; END IF; RETURN NEW; END $$`);
    await app.sql.run('CREATE TRIGGER fail_second_asset BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION fail_second_asset()');
    try { assert.equal((await request(path + '/sync', 'POST', {})).status, 500); } finally { await app.sql.run('DROP TRIGGER fail_second_asset ON records'); await app.sql.run('DROP FUNCTION fail_second_asset()'); }
    assert.deepEqual((await request('/api/state')).data.assets, before, 'A storage failure rolls back the complete import transaction.');
    mode = 'valid'; image.imageMediaMetadata.width = 1200;
    assert.equal((await request(path + '/sync', 'POST', {})).status, 200); savedImage = (await request('/api/state')).data.assets.find(asset => asset.id === savedImage.id); assert.equal(savedImage.approval, 'pending'); assert.equal(savedImage.deliveryUrl, custom.deliveryUrl); assert.equal(savedImage.description, custom.description);
    const uploadBody = { name: 'Upload.mp4', mimeType: 'video/mp4', contentBase64: Buffer.from('fixture video bytes').toString('base64') };
    result = await request(path + '/upload', 'POST', uploadBody, 'dam-upload-001'); assert.equal(result.status, 200); assert.equal(result.data.asset.duration, 15.05); assert.equal(result.data.asset.width, 1080);
    const uploadCount = writes.filter(write => write.upload).length; assert.equal((await request(path + '/upload', 'POST', uploadBody, 'dam-upload-001')).status, 200); assert.equal(writes.filter(write => write.upload).length, uploadCount);
    uploadMode = 'invalid'; result = await request(path + '/upload', 'POST', { ...uploadBody, name: 'Invalid.mp4' }, 'dam-upload-invalid'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    const afterInvalidUpload = writes.filter(write => write.upload).length; assert.equal((await request(path + '/upload', 'POST', { ...uploadBody, name: 'Invalid.mp4' }, 'dam-upload-new-key')).status, 409); assert.equal(writes.filter(write => write.upload).length, afterInvalidUpload);
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});

test('DAM GIFs retain their actual format and description alternative text when resolving platform copies', () => {
  const asset = { id: 'gif-asset', kind: 'image', mimeType: 'image/gif', url: 'https://cdn.example.com/creative.gif', description: 'A meaningful animated creative.', approval: 'approved', size: 1000, width: 500, height: 500 };
  const post = { content: 'Caption', assetId: asset.id }, variant = resolveVariant(post, 'facebook', [asset]);
  assert.equal(variant.mediaItems[0].type, 'gif'); assert.equal(variant.mediaItems[0].altText, asset.description);
  assert.equal(validatePostForPlatforms(post, ['instagram'], { assets: [asset] }).valid, false, 'DAM GIFs must not bypass a platform that accepts only image/video attachments.');
  assert.equal(resolveVariant(post, 'facebook', [{ ...asset, altText: 'Explicit alternative text' }]).mediaItems[0].altText, 'Explicit alternative text');
});
