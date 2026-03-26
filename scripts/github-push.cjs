#!/usr/bin/env node
/**
 * Incremental GitHub push via API.
 * Only uploads files whose content has changed (compares git blob SHA).
 * Usage: node scripts/github-push.cjs [commit message]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'Drincann';
const REPO = 'bitcold-preview';
const BASE = path.resolve(__dirname, '..');
const BRANCH = 'main';

if (!TOKEN) { console.error('GITHUB_TOKEN not set'); process.exit(1); }

const IGNORE_DIRS = new Set(['node_modules', '.git', '.local', 'dist', '.cache']);
const IGNORE_EXTS = new Set(['.map', '.log']);
const MAX_SIZE = 1.5 * 1024 * 1024;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function gitBlobSha(content) {
  // Git blob SHA: sha1("blob <size>\0<content>")
  const header = Buffer.from(`blob ${content.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

function api(method, apiPath, body, retries = 4) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'replit-agent',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        }
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          if (res.statusCode === 429 || res.statusCode === 403) {
            if (n > 1) return setTimeout(() => attempt(n - 1), 3000);
          }
          if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${raw.slice(0, 300)}`));
          resolve(JSON.parse(raw));
        });
      });
      req.on('error', e => n > 1 ? setTimeout(() => attempt(n - 1), 2000) : reject(e));
      if (data) req.write(data);
      req.end();
    };
    attempt(retries);
  });
}

function walkFiles(dir, rel = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rp = rel ? `${rel}/${e.name}` : e.name;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(walkFiles(full, rp));
    } else {
      if (IGNORE_EXTS.has(path.extname(e.name))) continue;
      const stat = fs.statSync(full);
      if (stat.size > MAX_SIZE) { console.log(`  skip large: ${rp}`); continue; }
      out.push({ rp, full });
    }
  }
  return out;
}

async function getRemoteTree(treeSha) {
  const result = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${treeSha}?recursive=1`);
  const map = {};
  for (const item of result.tree) {
    if (item.type === 'blob') map[item.path] = item.sha;
  }
  return map;
}

async function main() {
  const msg = process.argv[2] || 'chore: sync from replit';

  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const commitData = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
  const baseTreeSha = commitData.tree.sha;

  console.log(`Remote HEAD: ${headSha.slice(0, 8)}`);
  console.log('Fetching remote tree...');
  const remote = await getRemoteTree(baseTreeSha);

  const allFiles = walkFiles(BASE);
  const localPaths = new Set(allFiles.map(f => f.rp));

  // Detect changed/new files by comparing git blob SHAs
  const toUpload = [];
  for (const { rp, full } of allFiles) {
    const content = fs.readFileSync(full);
    const localSha = gitBlobSha(content);
    if (remote[rp] !== localSha) {
      toUpload.push({ rp, full, content });
    }
  }

  // Detect deleted files
  const deleted = Object.keys(remote).filter(p => !localPaths.has(p));

  console.log(`Changed: ${toUpload.length} | Deleted: ${deleted.length} | Unchanged: ${allFiles.length - toUpload.length}`);

  if (toUpload.length === 0 && deleted.length === 0) {
    console.log('Nothing to push.');
    return;
  }

  // Upload only changed/new blobs
  const newItems = [];
  for (let i = 0; i < toUpload.length; i++) {
    const { rp, content } = toUpload[i];
    await sleep(200);
    try {
      const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
        content: content.toString('base64'),
        encoding: 'base64',
      });
      newItems.push({ path: rp, mode: '100644', type: 'blob', sha: blob.sha });
      process.stdout.write(`\r  uploading: ${i + 1}/${toUpload.length} — ${rp.slice(-50)}`);
    } catch (e) {
      console.log(`\n  skip ${rp}: ${e.message.slice(0, 80)}`);
    }
  }
  if (toUpload.length > 0) console.log('');

  // Mark deleted files (sha: null removes them from the tree)
  for (const rp of deleted) {
    newItems.push({ path: rp, mode: '100644', type: 'blob', sha: null });
  }

  console.log('Building tree...');
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree: newItems,
  });

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg,
    tree: tree.sha,
    parents: [headSha],
  });

  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha,
    force: false,
  });

  console.log(`Pushed! ${commit.sha.slice(0, 8)} — "${msg}"`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
}

main().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
