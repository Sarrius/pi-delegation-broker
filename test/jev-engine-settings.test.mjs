import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEngineSettings,engineNextState,jevConfigFromEngine} from '../src/jev-engine-settings.mjs';

test('legacy advisory flags are not an operational-engine approval; malformed consent fails closed',()=>{
 assert.equal(normalizeEngineSettings(undefined).reason,'not_approved');
 assert.equal(jevConfigFromEngine(undefined).mode,'off');
 assert.equal(normalizeEngineSettings({schemaVersion:1,decisions:true,routing:true,scope:'all_cwds',consentToSendTaskText:false,autoThinkingMax:'low'}).reason,'consent_required');
 assert.equal(normalizeEngineSettings({schemaVersion:1,decisions:false,routing:true,scope:'all_cwds',consentToSendTaskText:true,autoThinkingMax:'low',rogue:true}).reason,'invalid_config');
});

test('on engages both decision and routing functions; individual off is not a hidden master switch',()=>{
 const on=engineNextState(undefined,'on');assert.equal(on.decisions,true);assert.equal(on.routing,true);
 assert.equal(jevConfigFromEngine(on).engineDecisions,true);
 assert.equal(jevConfigFromEngine(on).activeRouting,true);
 assert.equal(jevConfigFromEngine(on).activeScopeAll,true);
 const routeOff=engineNextState(on,'routing-off');assert.equal(routeOff.decisions,true);assert.equal(routeOff.routing,false);
 assert.equal(jevConfigFromEngine(routeOff).activeRouting,false);
 const routeOn=engineNextState(engineNextState(on,'off'),'routing-on');assert.equal(routeOn.decisions,false);assert.equal(routeOn.routing,true);
 assert.equal(jevConfigFromEngine(routeOn).engineDecisions,false);
 const off=engineNextState(on,'off');assert.equal(off.decisions,false);assert.equal(off.routing,false);
 assert.equal(jevConfigFromEngine(off).mode,'off');
});
