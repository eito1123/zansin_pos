import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const files = ['index.html', 'style.css', 'app.js', 'logic.js', 'db.js', 'manifest.webmanifest', 'icon.svg'];
await mkdir('dist', { recursive: true });
const hash = createHash('sha256');
for (const file of files) {
  hash.update(await readFile(file));
  await copyFile(file, `dist/${file}`);
}
const worker = await readFile('sw.js', 'utf8');
hash.update(worker);
const version = hash.digest('hex').slice(0, 16);
await writeFile('dist/sw.js', worker.replace("const CACHE = 'yakitori-pos-v1';", `const CACHE = 'yakitori-pos-${version}';`));
console.log(`Built static POS: dist (version ${version})`);
