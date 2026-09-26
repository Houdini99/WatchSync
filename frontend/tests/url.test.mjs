import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeMediaUrl } = await import('../src/lib/url.ts');

test('bare hosts get https', () => {
  assert.equal(normalizeMediaUrl('youtube.com/watch?v=abc'), 'https://youtube.com/watch?v=abc');
  assert.equal(normalizeMediaUrl('  www.example.com  '), 'https://www.example.com');
  assert.equal(normalizeMediaUrl('cdn.example.org:8443/a.m3u8'), 'https://cdn.example.org:8443/a.m3u8');
  assert.equal(normalizeMediaUrl('//cdn.example.org/a.mp4'), 'https://cdn.example.org/a.mp4');
});

test('links with a scheme are left alone', () => {
  assert.equal(normalizeMediaUrl('http://example.com/a.mp4'), 'http://example.com/a.mp4');
  assert.equal(normalizeMediaUrl('HTTPS://youtu.be/abc'), 'HTTPS://youtu.be/abc');
  assert.equal(normalizeMediaUrl('ftp://example.com/x'), 'ftp://example.com/x');
});

test('things that are not links are only trimmed', () => {
  assert.equal(normalizeMediaUrl(' just some words '), 'just some words');
  assert.equal(normalizeMediaUrl('localhost/a.mp4'), 'localhost/a.mp4');
  assert.equal(normalizeMediaUrl('file.mp4'), 'file.mp4');
  assert.equal(normalizeMediaUrl(''), '');
});
