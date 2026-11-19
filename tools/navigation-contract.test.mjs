import test from 'node:test';
import assert from 'node:assert/strict';
import { isTargetDocumentNavigation } from './navigation-contract.mjs';

test('only actual GET /b HTML document navigations trigger HTTP 204', () => {
  const candidate = { method: 'GET', pathname: '/b', rsc: undefined, dest: 'document', accept: 'text/html' };
  assert.equal(isTargetDocumentNavigation(candidate), true);
  assert.equal(isTargetDocumentNavigation({ ...candidate, dest: 'empty', accept: 'text/html,application/xhtml+xml' }), true);
  assert.equal(isTargetDocumentNavigation({ ...candidate, rsc: '1' }), false);
  assert.equal(isTargetDocumentNavigation({ ...candidate, dest: 'empty', accept: 'text/x-component' }), false);
  assert.equal(isTargetDocumentNavigation({ ...candidate, method: 'POST' }), false);
  assert.equal(isTargetDocumentNavigation({ ...candidate, pathname: '/a' }), false);
  assert.equal(isTargetDocumentNavigation({ ...candidate, pathname: '/b/sub' }), false);
  assert.equal(isTargetDocumentNavigation({ ...candidate, pathname: '/outside' }), false);
});
