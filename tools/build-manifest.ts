// manifest.json для сервера данных.
//
//   node tools/build-manifest.ts out/                         → out/manifest.json
//   node tools/build-manifest.ts --release assets.json out/   → для GitHub Releases
//
// Папки:   out/<id>/region.json + map.pmtiles / valhalla.tar / search.json
// Плоско:  out/<id>-region.json + <id>-map.pmtiles / <id>-valhalla.tar / <id>-search.json
// --release: размеры файлов берутся из списка ассетов релиза (gh release view --json assets),
//            а не с диска — большие файлы скачивать не нужно, только *-region.json.
// База вышек (необязательно): cellid.pmtiles рядом.

import fs from 'node:fs';
import path from 'node:path';

const FILES: Record<string, string> = { map: 'map.pmtiles', roads: 'valhalla.tar', search: 'search.json' };

export function buildManifest(dir: string, updated = new Date().toISOString().slice(0, 10), sizes?: Record<string, number>) {
  const size = (rel: string) => sizes ? sizes[rel] : fs.existsSync(path.join(dir, rel)) ? fs.statSync(path.join(dir, rel)).size : undefined;
  const regions: any[] = [];
  const add = (meta: any, id: string, rel: (name: string) => string) => {
    const r: any = { id: meta.id ?? id, name: meta.name ?? id, bbox: meta.bbox, version: meta.version ?? updated };
    for (const [part, name] of Object.entries(FILES)) {
      const b = size(rel(name));
      if (b != null) r[part] = { url: rel(name), bytes: b };
    }
    regions.push(r);
  };
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      const meta = path.join(full, 'region.json');
      if (fs.existsSync(meta)) add(JSON.parse(fs.readFileSync(meta, 'utf8')), entry, (n) => `${entry}/${n}`);
    } else if (entry.endsWith('-region.json')) {
      const id = entry.slice(0, -'-region.json'.length);
      add(JSON.parse(fs.readFileSync(full, 'utf8')), id, (n) => `${id}-${n}`);
    }
  }
  const out: any = { version: 1, updated, regions };
  if (size('cellid.pmtiles') != null) out.cells = 'cellid.pmtiles';
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let sizes: Record<string, number> | undefined;
  if (args[0] === '--release') {
    const assets = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    sizes = Object.fromEntries((assets.assets ?? assets).map((a: any) => [a.name, a.size]));
    args.splice(0, 2);
  }
  const dir = args[0] ?? 'out';
  const m = buildManifest(dir, undefined, sizes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  console.log(`manifest.json: областей ${m.regions.length}${m.cells ? ', есть база вышек' : ''}`);
}
