'use strict';
/**
 * Models of the claude CLI's /model picker, for the page's dropdown, /v1/models and translations.
 *
 * Source: the `list_models` control request of a short CLI process at server start (no session,
 * no model call), refreshed by the model list every chat run gets in its `initialize` answer.
 * Until the first answer: the "main" section of the model catalog the CLI caches as
 * ~/.claude/cache/model-catalog/<account>-cc.json (an internal, unversioned format).
 *
 * list() -> [{ id, name, main, efforts }] or null: id is the exact model ID (aliases resolved),
 * main marks the family entries the picker lists first (opus, sonnet…), efforts the effort levels
 * the model takes ([] = none; null = unknown, from the catalog). defaultModel() -> the ID the CLI
 * runs without --model, or null.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cliControl = require('./cli-control');

const CATALOG_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cache', 'model-catalog');
const MODEL_ID_RE = /^claude-[\w.-]+(\[1m\])?$/;

let models = null;
let defaultId = null;

/** Takes the CLI's ModelInfo list ({ value, resolvedModel, displayName, supportedEffortLevels… }). */
function update(infos) {
  if (!Array.isArray(infos)) return;
  const out = [];
  const seen = new Set();
  let def = null;
  for (const m of infos) {
    if (!m || typeof m.value !== 'string') continue;
    const id = [m.resolvedModel, m.value].find((v) => typeof v === 'string' && MODEL_ID_RE.test(v));
    if (!id) continue;
    if (m.value === 'default') { def = id; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: m.displayName || id,
      main: !m.value.startsWith('claude-'), // listed by family alias, not by a version's ID
      efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [],
    });
  }
  if (out.length) {
    models = out;
    defaultId = def;
  }
}

/** The newest cached catalog's "main" section, or null. Re-read per call, it's ~10 KB. */
function fromCatalog() {
  try {
    const newest = fs.readdirSync(CATALOG_DIR)
      .filter((f) => f.endsWith('-cc.json'))
      .map((f) => path.join(CATALOG_DIR, f))
      .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    const list = JSON.parse(fs.readFileSync(newest.f, 'utf8')).catalog.config.models
      .filter((m) => m && m.section === 'main' && MODEL_ID_RE.test(m.id))
      .map((m) => ({ id: m.id, name: m.name || m.id, main: true, efforts: null }));
    if (list.length) return list;
  } catch {}
  return null;
}

/** Asks a short CLI process for the list (`list_models`). */
async function refresh({ claudeBin, cwd, env }) {
  const [r] = await cliControl.oneShot({ claudeBin, cwd, requests: [{ subtype: 'list_models' }], env });
  if (r.error) throw new Error(r.error);
  update(r.models);
}

module.exports = {
  update,
  refresh,
  list: () => models || fromCatalog(),
  defaultModel: () => defaultId,
};
