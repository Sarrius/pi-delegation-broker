import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQualificationCanary } from "../src/qualification-canary.mjs";

for(const wrapped of [false,true])test(`canary explains envelopes but still requires literal file contents: wrapped=${wrapped}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"qc-envelope-")),sessionsRoot=join(root,"sessions"),resourceId="google-antigravity/claude-sonnet-5-5-low";
 try{
  const runner={async abort(){},async run({childId,cwd,prompt}){
   assert.match(prompt,/not JSON/);
   const path=join(cwd,"challenge.txt"),text=readFileSync(path,"utf8");
   const dir=join(sessionsRoot,childId,"sessions");mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,"fixture.jsonl"),[
    {message:{role:"assistant",content:[{type:"toolCall",id:"read1",name:"read",arguments:{path}}]}},
    {message:{role:"toolResult",toolCallId:"read1",toolName:"read",isError:false,content:[{type:"text",text}]}},
   ].map(x=>JSON.stringify(x)).join("\n"));
   return {status:"completed",route:[{resourceId}],text:wrapped?JSON.stringify({output:text}):text};
  }};
  const result=await createQualificationCanary({runner,root:join(root,"q"),sessionsRoot})({resourceId});
  assert.equal(result.status,wrapped?"failed":"verified");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("fatal qualification reports keep the original child error", async () => {
  const root = mkdtempSync(join(tmpdir(), "qc-"));
  try {
    const original = "Child exited (code null, signal SIGTERM). Stderr: (empty)";
    const runner = {
      async run() { return { status: "failed", text: "", error: original }; },
      async abort() {},
    };
    const result = await createQualificationCanary({
      runner, root: join(root, "q"), sessionsRoot: join(root, "s"),
    })({ resourceId: "deepseek/deepseek-v4-pro" });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "fatal");
    const reports = readdirSync(join(root, "q", "reports")).filter((name) => name.endsWith(".json"));
    assert.equal(reports.length, 1);
    const report = JSON.parse(readFileSync(join(root, "q", "reports", reports[0]), "utf8"));
    assert.equal(report.error, "fatal");
    assert.equal(report.routeExplanation, original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
