import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueRestoreAuthorityProof as issue } from "./customer-restore-authority-proof-issuer.mjs";
import { verifySignedRestoreAuthority as verify } from "./customer-restore-authority-signed-proof.mjs";
const keys=generateKeyPairSync("ed25519");
const privateKeyPem=keys.privateKey.export({type:"pkcs8",format:"pem"});
const publicKeyPem=keys.publicKey.export({type:"spki",format:"pem"});
const authority={customerId:"customer",installationId:"install",licenseId:"license",grantId:"grant",bindingEpoch:"epoch",authorizationState:"ACTIVE",revocationGeneration:2,migrationGeneration:3,challengeConsumptionGeneration:4,auditHighWater:5,tokenGeneration:6};
const nonce="0123456789abcdef0123456789abcdef";
const nowMs=1_800_000_000_000;
const make=(patch={})=>issue({authority,authorityKeyId:"operator-key-1",privateKeyPem,requestNonce:nonce,nowMs,...patch});
test("fresh signed authority proof round trips through verifier",()=>{
  const p=make();assert.equal(p.ok,true);
  const result=verify({restored:authority,statement:p.statement,signatureBase64:p.signatureBase64,trustedPublicKeys:{"operator-key-1":publicKeyPem},expectedNonce:nonce,nowMs:nowMs+1000});
  assert.equal(result.allowed,true);
});
test("signed proof cannot admit stale restored revocation counter",()=>{
  const p=make();const restored={...authority,revocationGeneration:1};
  assert.equal(verify({restored,statement:p.statement,signatureBase64:p.signatureBase64,trustedPublicKeys:{"operator-key-1":publicKeyPem},expectedNonce:nonce,nowMs:nowMs+1000}).allowed,false);
});
test("proof rejects mismatched challenge nonce",()=>{
  const p=make();assert.equal(verify({restored:authority,statement:p.statement,signatureBase64:p.signatureBase64,trustedPublicKeys:{"operator-key-1":publicKeyPem},expectedNonce:"othernonce0123456789",nowMs:nowMs+1000}).allowed,false);
});
test("issuer rejects unsupported signing key",()=>assert.equal(make({privateKeyPem:"not a key"}).ok,false));
test("issuer rejects empty or short nonce",()=>assert.equal(make({requestNonce:"short"}).ok,false));
test("issuer rejects overlong proof TTL",()=>assert.equal(make({ttlMs:60001}).ok,false));
test("issuer rejects negative counter",()=>assert.equal(make({authority:{...authority,tokenGeneration:-1}}).ok,false));
test("issuer rejects unsafe future expiry",()=>assert.equal(make({nowMs:Number.MAX_SAFE_INTEGER,ttlMs:1000}).ok,false));
test("expired signed proof rejected by verifier",()=>{
  const p=make({ttlMs:1000});assert.equal(verify({restored:authority,statement:p.statement,signatureBase64:p.signatureBase64,trustedPublicKeys:{"operator-key-1":publicKeyPem},expectedNonce:nonce,nowMs:nowMs+1001}).allowed,false);
});
