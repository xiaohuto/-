import {mkdir, readFile, writeFile, readdir, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const names = ['index.html', '_worker.js', '_routes.json', '_headers'];
await mkdir(output, {recursive: true});
const existing = await readdir(output);
if (existing.some(name => !names.includes(name)))
  throw new Error('dist contains unexpected files. Keep only the four deployment files.');
for (const name of names) {
  const bytes = await readFile(path.join(root, 'web', name));
  if (bytes.length > 25 * 1024 * 1024) throw new Error(name + ' exceeds the Pages file size limit.');
  if (/sk-(?:proj-)?[A-Za-z0-9_-]{30,}/.test(bytes.toString('utf8')))
    throw new Error('A credential was found in public source; move it to Cloudflare Secrets.');
  await writeFile(path.join(output, name), bytes);
}
const html = await readFile(path.join(output, 'index.html'), 'utf8');
const seed = JSON.parse(html.match(/<script id="seedData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
if (seed.rules.length !== 40 || seed.refs.length !== 12)
  throw new Error('Merged rules or references are missing.');
for (const name of names) console.log('Ready: dist/' + name + ' (' + (await stat(path.join(output, name))).size + ' bytes)');
console.log('Build complete. Pages build output directory: dist');
