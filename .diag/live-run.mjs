import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs'; import {homedir, tmpdir} from 'node:os'; import {join} from 'node:path';
import {readProviderRegistry} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/dynamic-provider-watcher.mjs';
import {buildCurrencyMap} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/provider-probe.mjs';
import {createSelectContract, parseResourceModel} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/model-selector.mjs';
import {signedRegistryMessage} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/signed-registry.mjs';
import {writeScopedChildAuth} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/scoped-child-auth.mjs';
import {SingleHostBrokerSupervisor} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/supervisor.mjs';
import {BrokeredLaunchResolver} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/trusted-launch-resolver.mjs';
import {BrokeredChildRunner} from '/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/src/brokered-runner.mjs';
let stage='init';
const s=(x)=>{stage=x;console.log(new Date().toISOString().slice(11,19),'STAGE:',x)};
const wd=setTimeout(()=>{console.log('!!! STUCK AT STAGE:',stage);process.exit(3)},100000);
const AGENT=join(homedir(),'.pi','agent'); const root=mkdtempSync(join(tmpdir(),'diag-'));
const PROMPT='Reply with exactly one word: hello';
const digest=createHash('sha256').update(PROMPT).digest('hex');
s('read registry'); const registry=readProviderRegistry(AGENT);
const {publicKey,privateKey}=generateKeyPairSync('ed25519'); const now=Date.now();
const unsigned={schemaVersion:2,keyId:'k',registry:{registryVersion:'v1',issuedAt:now-1000,expiresAt:now+600000,...registry}};
s('start supervisor');
const sup=new SingleHostBrokerSupervisor({stateDir:root,signedRegistry:{...unsigned,signature:sign(null,signedRegistryMessage(unsigned),privateKey).toString('base64url')},trustedRegistryKeys:{k:publicKey.export({type:'spki',format:'pem'})},controllerToken:'l'.repeat(48),sweepIntervalMs:1000});
await sup.start();
s('build resolver');
const resolver=new BrokeredLaunchResolver({socketPath:sup.socketPath,controllerToken:sup.controllerToken,agentRoot:join(root,'agents'),extensionPaths:[new URL('/Users/example/.pi/research/delegation-doctrine/publication/pi-delegation-broker/extensions/child-shim.ts',import.meta.url).pathname],offline:false,
 selectContract:createSelectContract({registry,availability:()=>sup.inventory(),currency:buildCurrencyMap({resources:Object.entries(registry.resources).map(([id,r])=>r.model??parseResourceModel(id))}),enforceQuality:true}),
 resolveModelForResource:parseResourceModel,
 provisionChildAuth:({agentDir,model})=>writeScopedChildAuth({agentDir,provider:model.provider,parentAgentDir:AGENT})});
const runner=new BrokeredChildRunner({resolver,sessionsRoot:join(root,'sessions'),promptTimeoutMs:60000});
s('spawn child');
const res0=await runner.run({childId:"diag-child",promptDigest:digest,cwd:root,thinkingLevel:"off",prompt:PROMPT});console.log("   route:",JSON.stringify(res0.route));const handle={model:res0.resolved,resource:{id:"n/a"},result:Promise.resolve(res0)};
console.log('   leased:',JSON.stringify(handle.model),handle.resource?.id);
s('await result');
const res=await handle.result;
console.log('   result:',res.status,JSON.stringify((res.text||res.error||'').slice(0,120)));
s('dispose'); await runner.dispose(); await sup.stop(); rmSync(root,{recursive:true,force:true});
clearTimeout(wd); s('done'); process.exit(0);
