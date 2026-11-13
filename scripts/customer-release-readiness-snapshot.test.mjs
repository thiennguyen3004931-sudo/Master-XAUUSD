import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCustomerReleaseSnapshot as evaluate, REQUIRED_WORKFLOWS } from "./customer-release-readiness-snapshot.mjs";
const sha = "a".repeat(40);
const pass = REQUIRED_WORKFLOWS.map(name => ({name,head_sha:sha,event:"push",status:"completed",conclusion:"success"}));

test("release cannot be approved even when all GitHub-only evidence is green",()=>{
  const result=evaluate({sha,issues:{166:"closed",176:"closed"},workflowRuns:pass});
  assert.equal(result.status,"BLOCKED");
  assert.equal(result.releaseAuthorized,false);
  assert.equal(result.workflows.every(x=>x.exactShaVerified),true);
  assert.deepEqual(result.blockers,["INDEPENDENT_AUTHORITY_HOST_AND_PUBLISHER_APPROVAL_NOT_ATTESTED"]);
});
test("open security issue blocks readiness",()=>{
  const result=evaluate({sha,issues:{166:"open",176:"open"},workflowRuns:pass});
  assert.ok(result.blockers.includes("ISSUE_166_NOT_CLOSED"));
  assert.ok(result.blockers.includes("ISSUE_176_NOT_CLOSED"));
});
test("CI on previous SHA is never accepted",()=>{
  const old=pass.map(x=>({...x,head_sha:"b".repeat(40)}));
  const result=evaluate({sha,issues:{166:"closed",176:"closed"},workflowRuns:old});
  assert.equal(result.workflows.some(x=>x.exactShaVerified),false);
});
test("queued, skipped and failed workflows do not pass",()=>{
  const runs=pass.map(x=>({...x,status:"queued",conclusion:null}));
  const result=evaluate({sha,issues:{166:"closed",176:"closed"},workflowRuns:runs});
  assert.equal(result.workflows.every(x=>!x.exactShaVerified),true);
});
test("invalid source SHA denies",()=>{
  const result=evaluate({sha:"not-a-commit",issues:{166:"closed",176:"closed"},workflowRuns:pass});
  assert.ok(result.blockers.includes("SOURCE_SHA_MISSING"));
  assert.equal(result.sourceSha,null);
});
test("unavailable issue evidence denies",()=>{
  const result=evaluate({sha,issues:{},workflowRuns:pass});
  assert.ok(result.blockers.includes("ISSUE_176_NOT_CLOSED"));
});

test("latest queued or failed rerun supersedes earlier green on identical SHA",()=>{
  const old=pass.map((x,i)=>({...x,id:i+1}));
  const failed={...old[0],id:100,status:"completed",conclusion:"failure"};
  const queued={...old[1],id:101,status:"queued",conclusion:null};
  const result=evaluate({sha,issues:{166:"closed",176:"closed"},workflowRuns:[...old,failed,queued]});
  assert.equal(result.workflows[0].exactShaVerified,false);
  assert.equal(result.workflows[1].exactShaVerified,false);
  assert.equal(result.workflows[2].exactShaVerified,true);
});
