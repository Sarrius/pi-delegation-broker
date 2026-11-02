// Separate owner approval for the operational Jev engine. Old advisory/shadow flags
// never silently become consent to send briefs or change real delegation choices.
export const ENGINE_SETTINGS_VERSION=1;
const OFF=Object.freeze({schemaVersion:ENGINE_SETTINGS_VERSION,decisions:false,routing:false,
  consentToSendTaskText:false,scope:'none',autoThinkingMax:'low',visual:false,consentToSendImages:false});
export function normalizeEngineSettings(raw){
 if(raw===undefined)return {...OFF,reason:'not_approved'};
 if(!raw||typeof raw!=='object'||Array.isArray(raw)
  ||Object.keys(raw).some(key=>!Object.hasOwn(OFF,key))
  ||raw.schemaVersion!==ENGINE_SETTINGS_VERSION
  ||typeof raw.decisions!=='boolean'||typeof raw.routing!=='boolean'
  ||typeof raw.consentToSendTaskText!=='boolean'
  ||(raw.visual!==undefined&&typeof raw.visual!=='boolean')
  ||(raw.consentToSendImages!==undefined&&typeof raw.consentToSendImages!=='boolean')
  ||!['none','all_cwds'].includes(raw.scope)||!['off','low'].includes(raw.autoThinkingMax))return {...OFF,reason:'invalid_config'};
 if((raw.decisions||raw.routing||raw.visual)&&(!raw.consentToSendTaskText||raw.scope!=='all_cwds'))return {...OFF,reason:'consent_required'};
 if(raw.visual&&!raw.consentToSendImages)return {...OFF,reason:'image_consent_required'};
 return {...OFF,...raw,reason:raw.decisions||raw.routing||raw.visual?'ready':'disabled'};
}
export function engineNextState(raw,action){
 const existing=normalizeEngineSettings(raw);
 if(!['on','off','decisions-on','decisions-off','routing-on','routing-off','visual-on','visual-off'].includes(action))throw Error('invalid engine action');
 if(action==='off')return {...OFF};
 if(existing.reason==='invalid_config')throw Error('invalid existing engine settings; no activation');
 const state={schemaVersion:ENGINE_SETTINGS_VERSION,decisions:existing.decisions,routing:existing.routing,
   consentToSendTaskText:existing.consentToSendTaskText,scope:existing.scope,autoThinkingMax:existing.autoThinkingMax,
   visual:existing.visual,consentToSendImages:existing.consentToSendImages};
 if(action==='on')state.decisions=state.routing=true;
 else if(action==='decisions-on')state.decisions=true;
 else if(action==='routing-on')state.routing=true;
 else if(action==='decisions-off')state.decisions=false;
 else if(action==='routing-off')state.routing=false;
 else if(action==='visual-on'){state.visual=true;state.consentToSendImages=true;}
 else if(action==='visual-off'){state.visual=false;state.consentToSendImages=false;}
 if(state.decisions||state.routing||state.visual){state.consentToSendTaskText=true;state.scope='all_cwds';}
 return state;
}
/** New engine config is a separate trust domain; old files are never promoted. */
export function jevConfigFromEngine(raw,{model='jev-1.13.0',timeoutMs=1500,maxRequestsPerSession=50}={}){
 const s=normalizeEngineSettings(raw);if(s.reason!=='ready')return {mode:'off'};
 return {mode:'advisory',consentToSendTaskText:true,handoff:false,result:false,
   routeShadow:false,consentToSendRoutingState:false,
   activeRouting:s.routing,consentToSendActiveRoutingState:s.routing,
   activeProjectRoots:[],activeScopeAll:s.scope==='all_cwds',activeAutoThinkingMax:s.autoThinkingMax,
   engineDecisions:s.decisions,visual:s.visual,consentToSendImages:s.consentToSendImages,
   visualModel:'jev-1.14.0',model,timeoutMs,maxRequestsPerSession};
}
