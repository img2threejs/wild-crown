#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm, readFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const exporter=path.join(project,"scripts/assets/export-runtime-manifest.mjs");
const temporary=await mkdtemp(path.join(os.tmpdir(),"wild crown manifest guards-"));
const temporaryExporter=path.join(temporary,"scripts/assets/export-runtime-manifest.mjs");
const run=(args=[],entry=temporaryExporter)=>spawnSync(process.execPath,[entry,...args],{cwd:temporary,encoding:"utf8"});
const actor={id:"prop-hash-fixture",sourceType:"native-glb",kind:"prop",nativeGlb:null,runtimeUrl:null,sourceInputHash:null,sourceHash:null,outputHash:null,lodIds:[],requiredActionIds:[],actionToClipMapping:{},sockets:[],collisionProxyId:null,provenance:{status:"fixture-only",reference:{path:"isolated-reference.png",sha256:"b".repeat(64)},providerTaskId:null},providerTaskId:null,gates:{G1:"not-applicable",G3:"not-applicable",G6:"not-started",G10:"not-started",G11:"not-started",G12:"not-applicable"},evidenceStatus:"blocked",evidence:null};
try{
  await mkdir(path.join(temporary,"scripts/assets"),{recursive:true});
  await copyFile(exporter,path.join(temporary,"scripts/assets/export-runtime-manifest.mjs"));
  const manifest={schemaVersion:2,manifestVersion:"test-only",assets:[structuredClone(actor)],environmentRecipes:[{id:"test-environment",sourceType:"composed-recipe",kind:"environment",proceduralRecipeId:"test-environment",componentAssetIds:["prop-hash-fixture"],evidenceStatus:"blocked",state:"test-only",runtimeUrl:null,nativeGlb:null,evidence:null}]};
  const sourcePath=path.join(temporary,"asset-source/manifest.json");
  await mkdir(path.dirname(sourcePath),{recursive:true});await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  let result=run();assert.equal(result.status,0,result.stderr);
  const runtimePath=path.join(temporary,"public/assets/manifest.json");
  const runtime=JSON.parse(await readFile(runtimePath,"utf8"));
  assert.deepEqual(runtime.map(entry=>entry.id),["prop-hash-fixture","test-environment"]);
  const native=runtime.find(entry=>entry.id===actor.id);
  for(const key of ["kind","sourceType","nativeGlb","runtimeUrl","sourceInputHash","sourceHash","outputHash","providerTaskId","gates","evidenceStatus","evidence","requiredActionIds","actionToClipMapping"])assert.deepEqual(native[key],actor[key]);
  assert.equal(native.provenance,"asset-source/manifest.json#"+actor.id);
  const recipe=runtime.find(entry=>entry.kind==="environment");
  assert.equal(recipe.sourceType,"composed-recipe");assert.deepEqual(recipe.componentAssetIds,[actor.id]);assert.equal(recipe.evidence,null);
  const beforeImport=await readFile(runtimePath,"utf8");
  // Library imports must not execute the CLI, even when source contents changed.
  manifest.assets[0].evidenceStatus="not-started";await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  const importer=path.join(temporary,"import-exporter.mjs");
  await writeFile(importer,"import "+JSON.stringify(pathToFileURL(temporaryExporter).href)+";\n");
  result=spawnSync(process.execPath,[importer],{cwd:temporary,encoding:"utf8"});assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(runtimePath,"utf8"),beforeImport);
  const linkedExporter=path.join(temporary,"scripts/assets/exporter symlink.mjs");
  await symlink("export-runtime-manifest.mjs",linkedExporter);
  result=run([],linkedExporter);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(await readFile(runtimePath,"utf8")).find(entry=>entry.id===actor.id).evidenceStatus,"not-started");
  manifest.assets[0].evidenceStatus="blocked";await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  result=run(["--check"]);assert.notEqual(result.status,0);assert.match(result.stderr,/manifest\.json is stale/);
  const badHash="0".repeat(64);const relative="assets/prop-hash-fixture/"+badHash+".glb";
  await mkdir(path.join(temporary,"public/assets/prop-hash-fixture"),{recursive:true});await writeFile(path.join(temporary,"public",relative),Buffer.from("wrong GLB bytes"));
  Object.assign(manifest.assets[0],{evidenceStatus:"verified",nativeGlb:relative,runtimeUrl:"/"+relative,sourceHash:badHash,outputHash:badHash,evidence:"evidence/assets/prop-hash-fixture.json"});await writeFile(sourcePath,JSON.stringify(manifest,null,2)+"\n");
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/Native GLB SHA-256 mismatch/);
  console.log("manifest guards passed: stale public catalog and mismatched native output hash both rejected");
}finally{await rm(temporary,{recursive:true,force:true});}
