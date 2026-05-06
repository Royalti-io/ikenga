#!/usr/bin/env bun
//
// design/scripts/bundle.ts — inline `_shared/*.css` and `_shared/*.js` into
// each design HTML so the result is a single, self-contained, double-clickable
// `file://` artifact. Source files keep their `<link>` / `<script src>` tags
// for in-editor authoring; the bundler swaps those tags for inline `<style>`
// and `<script>` blocks.
//
// Usage:
//   bun run design/scripts/bundle.ts
//   bun run design:bundle             (via package.json shortcut)

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const DESIGN_DIR = resolve(__dirname, "..");
const SOURCE_ROOT = join(DESIGN_DIR, "concepts");
const DIST_ROOT = join(DESIGN_DIR, "_dist");

const LINK_RE = /<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi;
const SCRIPT_SRC_RE = /<script\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/i;

function extractHref(tag: string): string | null {
  const m = tag.match(HREF_RE);
  return m ? m[1] : null;
}

function isLocalRef(ref: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith("//") && !ref.startsWith("data:");
}

function bundleHtml(srcPath: string): string {
  const html = readFileSync(srcPath, "utf-8");
  const srcDir = dirname(srcPath);

  const stylesInlined = html.replace(LINK_RE, (tag) => {
    const href = extractHref(tag);
    if (!href || !isLocalRef(href)) return tag;
    const cssPath = resolve(srcDir, href);
    if (!existsSync(cssPath)) return tag;
    const css = readFileSync(cssPath, "utf-8");
    return `<style data-bundled-from="${href}">\n${css}\n</style>`;
  });

  const scriptsInlined = stylesInlined.replace(SCRIPT_SRC_RE, (tag, src: string) => {
    if (!isLocalRef(src)) return tag;
    const jsPath = resolve(srcDir, src);
    if (!existsSync(jsPath)) return tag;
    const js = readFileSync(jsPath, "utf-8");
    return `<script data-bundled-from="${src}">\n${js}\n</script>`;
  });

  return scriptsInlined;
}

function walkHtml(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_")) continue; // skip _shared, _temp, etc.
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkHtml(full, files);
    else if (entry.endsWith(".html")) files.push(full);
  }
  return files;
}

function main() {
  if (existsSync(DIST_ROOT)) rmSync(DIST_ROOT, { recursive: true, force: true });
  mkdirSync(DIST_ROOT, { recursive: true });

  const sources = walkHtml(SOURCE_ROOT);
  let bundled = 0;
  for (const src of sources) {
    const rel = relative(SOURCE_ROOT, src);
    const out = join(DIST_ROOT, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bundleHtml(src), "utf-8");
    bundled++;
    console.log(`  ${rel}`);
  }

  console.log(`\nbundled ${bundled} file(s) → ${relative(process.cwd(), DIST_ROOT)}/`);
}

main();
