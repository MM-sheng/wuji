// The site is one static file: no external scripts, styles or fonts, and it may only talk to an Ethereum RPC
// and mempool.space. Its contract address and anchor must match the deployment manifest it claims to show.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../../contracts/deployments/sepolia-header.json', import.meta.url), 'utf8'));

test('loads nothing from other origins', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/i);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  const origins = new Set([...html.matchAll(/fetch\(\s*`?\$\{?([A-Za-z.]+)|https:\/\/[a-z0-9.-]+/gi)].map(m => m[0]));
  const hosts = [...html.matchAll(/'(https:\/\/[a-z0-9.-]+)[^']*'/g)].map(m => new URL(m[1]).host);
  for (const h of hosts) assert.match(h, /(^|\.)publicnode\.com$|^mempool\.space$|^sepolia\.etherscan\.io$/, h);
  assert.ok(origins.size > 0);
});

test('shows the deployed Sepolia index and its anchor', () => {
  assert.ok(html.includes(`index: '${manifest.WujiHeaderIndex}'`), 'index address');
  assert.ok(html.includes(`anchor: ${manifest.anchorHeight},`), 'anchor height');
  assert.ok(html.includes(`chainId: ${manifest.chainId},`), 'chain id');
});

test('every translated key exists in the page', () => {
  const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]));
  const zh = [...html.matchAll(/'([a-z0-9]+\.[a-z0-9]+)':/g)].map(m => m[1]);
  for (const k of zh) assert.ok(keys.has(k), 'unused translation ' + k);
  for (const k of keys) assert.ok(zh.includes(k), 'untranslated ' + k);
});
