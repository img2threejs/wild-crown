#!/usr/bin/env node
// Reproducible Tripo chain for playtest assets (job tables: scripts/assets/tripo-chain-jobs.mjs).
// Each job runs: concept image -> Ultra model -> baked decimation -> (rig check -> rig -> retarget batches).
// Every step writes its own task.json under asset-source/generated/<asset>-<step>-01/tripo-out.
// Usage: node scripts/assets/tripo-greenwake-chain.mjs [--map=greenwake|canopy|grove|moonpine|mistveil|shared] [--through=concept|model|decimate|check|rig|anim]
//                                                      <job-id> [<job-id> ...]
// `--through` stops after that step so concept / preview images can be reviewed before credits are spent on
// the next step; finished steps are never re-run (their result.json is the marker).
// `--revision=N` writes every step of a job as <asset>-<step>-0N instead of -01, keeping a rejected earlier
// attempt on disk (its result.json stays the evidence). Without it a job uses the newest finished concept
// revision and revision 1 for the later steps; `--redo-concept` generates the next concept revision.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAPS } from './tripo-chain-jobs.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const STEPS = ['concept', 'model', 'decimate', 'check', 'rig', 'anim'];
const option = name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const mapName = option('map') ?? 'greenwake';
const through = option('through') ?? 'anim';
const map = MAPS[mapName];
if (!map) { console.error(`Unknown map ${mapName}; maps: ${Object.keys(MAPS).join(', ')}`); process.exit(2); }
if (!STEPS.includes(through)) { console.error(`Unknown --through ${through}; steps: ${STEPS.join(', ')}`); process.exit(2); }
const revision = Number(option('revision') ?? 1);
if (!Number.isInteger(revision) || revision < 1) { console.error('--revision must be a positive integer'); process.exit(2); }
const redoConcept = process.argv.includes('--redo-concept');
const reached = name => STEPS.indexOf(name) <= STEPS.indexOf(through);
const LOG = resolve(ROOT, map.log);

const CONCURRENCY_RETRIES = 12;
function runOnce(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tripo', [...args, '--json', '--yes', '--quiet', '--no-open'], { cwd: ROOT, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => {
      const text = out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      let json; try { json = JSON.parse(text); } catch { /* reported below */ }
      if (code !== 0 || !json || json.error || json.status !== 'success') {
        const error = new Error(`tripo ${args.slice(0, 3).join(' ')} failed (${code}): ${text || err.slice(-800)}`);
        error.concurrency = json?.http_status === 429 || /concurrency limit/i.test(text + err);
        reject(error);
      } else resolvePromise(json);
    });
  });
}
/** Generation tasks share one account concurrency pool; back off and resubmit on HTTP 429 only. */
async function run(args) {
  for (let attempt = 1; ; attempt++) {
    try { return await runOnce(args); } catch (error) {
      if (!error.concurrency || attempt >= CONCURRENCY_RETRIES) throw error;
      await new Promise(done => setTimeout(done, 20000 + attempt * 10000));
    }
  }
}
async function log(entry) { await appendFile(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
async function step(asset, name, args, stepRevision = revision) {
  const tag = `${name}-${String(stepRevision).padStart(2, '0')}`;
  const dir = `asset-source/generated/${asset}-${tag}`;
  const marker = resolve(ROOT, dir, 'result.json');
  if (existsSync(marker)) return JSON.parse(await readFile(marker, 'utf8'));
  await mkdir(resolve(ROOT, dir), { recursive: true });
  const started = new Date().toISOString();
  const result = await run([...args, '-o', dir, '--name', `${asset}-${tag}`]);
  const record = { ...result, started, finished: new Date().toISOString() };
  await writeFile(marker, JSON.stringify(record, null, 2) + '\n');
  await log({ asset, step: name, task_id: result.task_id, credits: result.credits_consumed ?? null, output_dir: result.output_dir });
  return record;
}

async function chain(asset) {
  const job = map.jobs[asset];
  if (!job) throw new Error(`Unknown job ${asset} for map ${mapName}`);
  let image = job.existingConcept;
  if (!image) {
    let conceptRevision = revision;
    if (option('revision') === undefined) {
      while (existsSync(resolve(ROOT, `asset-source/generated/${asset}-concept-${String(conceptRevision + 1).padStart(2, '0')}`, 'result.json'))) conceptRevision++;
      if (redoConcept) conceptRevision++;
    }
    const concept = await step(asset, 'concept', ['generate', 'text-to-image', job.concept, '--model', 'banana_pro'], conceptRevision);
    image = `${concept.output_dir}/generated_image.png`;
    // A hand-cleaned copy (generation artefacts such as ghosted duplicates painted out) takes precedence.
    const cleaned = `${concept.output_dir}/generated_image_clean.png`;
    if (existsSync(resolve(ROOT, cleaned))) image = cleaned;
  }
  if (!reached('model')) return { asset, concept: image };
  const model = await step(asset, 'model', ['generate', 'image-to-model', image, '--model', 'tripo-v3.1',
    '-p', 'geometry_quality=detailed', '-p', 'texture_quality=extreme', '-p', 'pbr=true', '-p', 'enable_image_autofix=true']);
  if (!reached('decimate')) return { asset, model: model.task_id };
  const lod = await step(asset, 'decimate', ['mesh', 'decimate', model.task_id, '--face-limit', String(job.faces)]);
  if (!job.rig || !reached('check')) return { asset, model: model.task_id, decimate: lod.task_id };
  let check = job.checkRig ? await step(asset, 'check', ['anim', 'check', lod.task_id]) : undefined;
  if (check && !check.output) {
    // The rig-check verdict (riggable / recommended rig_type) is only in the task record, not in the download.
    const detail = await run(['task', 'get', check.task_id]);
    check = { ...check, output: detail.output };
    await writeFile(resolve(ROOT, `asset-source/generated/${asset}-check-${String(revision).padStart(2, '0')}`, 'result.json'), JSON.stringify(check, null, 2) + '\n');
  }
  if (!reached('rig')) return { asset, model: model.task_id, decimate: lod.task_id, check };
  const rigParams = Object.entries(job.rigParams ?? {}).flatMap(([key, value]) => ['-p', `${key}=${value}`]);
  const rig = await step(asset, 'rig', ['anim', 'rig', lod.task_id, '--rig-type', job.rig, '--spec', job.spec ?? 'tripo', '--out-format', 'glb', ...rigParams]);
  const anims = [];
  const batches = job.batches ?? map.batches[job.rig] ?? [];
  if (reached('anim')) for (const [index, batch] of batches.entries()) {
    anims.push(await step(asset, `anim-${String.fromCharCode(97 + index)}`, ['anim', 'retarget', rig.task_id, '--animation', ...batch, '--animate-in-place', '--out-format', 'glb']));
  }
  return { asset, model: model.task_id, decimate: lod.task_id, check, rig: rig.task_id, anims: anims.map(item => item.task_id) };
}

const ids = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (!ids.length) { console.error(`Jobs (${mapName}): ${Object.keys(map.jobs).join(', ')}`); process.exit(2); }
const results = await Promise.allSettled(ids.map(chain));
for (const [index, result] of results.entries()) {
  if (result.status === 'fulfilled') console.log(JSON.stringify(result.value));
  else { console.error(`${ids[index]}: ${result.reason?.message ?? result.reason}`); process.exitCode = 1; }
}
