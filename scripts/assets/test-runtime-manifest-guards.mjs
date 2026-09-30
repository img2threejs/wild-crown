#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const exporter=path.join(project,"scripts/assets/export-runtime-manifest.mjs");
const temporary=await mkdtemp(path.join(os.tmpdir(),"wild-crown-manifest-guards-"));
const run=(args=[])=>spawnSync(process.execPath,[path.join(temporary,"scripts/assets/export-runtime-manifest.mjs"),...args],{cwd:temporary,encoding:"utf8"});
const actor={id:"prop-hash-fixture",sourceType:"native-glb",kind:"prop",nativeGlb:null,runtimeUrl:null,sourceInputHash:null,sourceHash:null,outputHash:null,lodIds:[],requiredActionIds:[],actionToClipMapping:{},sockets:[],collisionProxyId:null,provenance:"fixture-only",evidenceStatus:"blocked",evidence:null};
try{
  await mkdir(path.join(temporary,"scripts/assets"),{recursive:true});
  await copyFile(exporter,path.join(temporary,"scripts/assets/export-runtime-manifest.mjs"));
  const manifest={schemaVersion:2,manifestVersion:"test-only",assets:[structuredClone(actor)],environmentRecipes:[{id:"test-environment",sourceType:"composed-recipe",kind:"environment",proceduralRecipeId:"test-environment",componentAssetIds:["prop-hash-fixture"],evidenceStatus:"blocked",state:"test-only",runtimeUrl:null,nativeGlb:null,evidence:null}]};
  const sourcePath=path.join(temporary,"asset-source/manifest.json");
  await mkdir(path.dirname(sourcePath),{recursive:true});await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/wrote \/assets\/manifest.json/);
  const runtime=JSON.parse(await (await import("node:fs/promises")).readFile(path.join(temporary,"public/assets/manifest.json"),"utf8"));
  assert.equal(runtime.length,2);
  for(const entry of runtime){assert.ok(["character","prop","environment"].includes(entry.kind));assert.ok(Array.isArray(entry.requiredActionIds));assert.ok(entry.actionToClipMapping&&typeof entry.actionToClipMapping==="object");}
  assert.equal(runtime.find(entry=>entry.kind==="environment").sourceType,"composed-recipe");
  manifest.assets[0].evidenceStatus="not-started";await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  result=run(["--check"]);assert.notEqual(result.status,0);assert.match(result.stderr,/manifest\.json is stale/);
  const badHash="0".repeat(64);const relative="assets/prop-hash-fixture/"+badHash+".glb";
  await mkdir(path.join(temporary,"public/assets/prop-hash-fixture"),{recursive:true});await writeFile(path.join(temporary,"public",relative),Buffer.from("wrong GLB bytes"));
  Object.assign(manifest.assets[0],{evidenceStatus:"verified",nativeGlb:relative,runtimeUrl:"/"+relative,sourceHash:badHash,outputHash:badHash,evidence:"evidence/assets/prop-hash-fixture.json"});await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/Native GLB SHA-256 mismatch/);
  console.log("manifest guards passed: stale public catalog and mismatched native output hash both rejected");
}finally{await rm(temporary,{recursive:true,force:true});}
