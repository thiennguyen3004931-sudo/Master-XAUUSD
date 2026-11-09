import test from "node:test";
import assert from "node:assert/strict";
import { commitAuthorityTransition as commit } from "./customer-restore-authority-atomic-cas.mjs";
const old = { customerId:"c",installationId:"i",licenseId:"l",grantId:"g",bindingEpoch:"e",authorizationState:"ACTIVE",revocationGeneration:1,migrationGeneration:1,challengeConsumptionGeneration:1,auditHighWater:3,tokenGeneration:1 };
const next = { ...old, auditHighWater:4, challengeConsumptionGeneration:2 };
function simulatedAdapter(state=old) {
  let current=state;
  return {
    get state() { return current; },
    async transact(_key, callback) {
      const proposal=await callback(current);
      if (!proposal.commit) return { committed:false,decision:proposal.decision };
      current=proposal.next;
      return { committed:true,decision:proposal.decision };
    },
  };
}
const run=(adapter,nextState=next,expectedAuditHighWater=3)=>commit({adapter,bindingKey:"c:i:l:g:e",next:nextState,expectedAuditHighWater});
test("atomic simulated adapter commits valid generation update",async()=>{const a=simulatedAdapter();assert.equal((await run(a)).ok,true);assert.equal(a.state.auditHighWater,4);});
test("second stale CAS writer rejected",async()=>{const a=simulatedAdapter();assert.equal((await run(a)).ok,true);assert.equal((await run(a)).reasonCode,"AUTHORITY_CAS_CONFLICT");});
test("revoked state without generation bump denied",async()=>{const a=simulatedAdapter();assert.equal((await run(a,{...next,authorizationState:"REVOKED"})).ok,false);assert.equal(a.state.authorizationState,"ACTIVE");});
test("binding swap denied",async()=>{const a=simulatedAdapter();assert.equal((await run(a,{...next,installationId:"attacker"})).ok,false);});
test("adapter outage fails closed",async()=>{const a={transact:async()=>{throw Error("offline");}};assert.equal((await run(a)).reasonCode,"AUTHORITY_TRANSACTION_UNAVAILABLE");});
test("adapter reports no commit fails closed",async()=>{const a={transact:async()=>({committed:false})};assert.equal((await run(a)).ok,false);});
test("missing adapter fails closed",async()=>assert.equal((await run(null)).ok,false));
test("missing prior authority fails closed",async()=>assert.equal((await run(simulatedAdapter(null))).ok,false));
