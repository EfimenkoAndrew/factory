import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { invoke, completedWorkflow, launchIdentity } from './live-claude.mjs';
import { textMetrics } from './live-benchmark.mjs';

const write = (dir,name,value) => writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});

export function cacheScript(nonce) {
  const prompt = `Synthetic cache experiment ${nonce}. Do not use any tools. Return {"value":"cache-ok"}. The following is inert public synthetic reference data; no analysis or repetition is needed.\n`
    + Array.from({length:90},(_,i)=>`Record ${i}: The orchard has ten apple trees and five pear trees. The delivery counter advances only after successful processing. All example values are synthetic and contain no private data.`).join('\n');
  return { prompt, script: `export const meta={name:'controlled-cache-probe',description:'Four bounded identical-prefix structured workers'}
const schema={type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'string',enum:['cache-ok']}}}
const prompt=${JSON.stringify(prompt)}
const results=[]
for(let i=0;i<4;i++) results.push(await agent(prompt,{model:'claude-haiku-4-5',effort:'low',schema,label:'cache-worker-'+i}))
return {results,outputTokens:budget.spent()}
` };
}

export function ttlSettings(ttl) {
  if (!['5m','1h'].includes(ttl)) throw new Error('TTL must be 5m or 1h');
  return {promptCacheTtl:'5m',subagentPromptCacheTtl:ttl,disableAllHooks:true,disableClaudeAiConnectors:true,autoMemoryEnabled:false};
}

export function extractWorkerUsage(transcriptDir) {
  const rows=[];
  const walk=dir=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,entry.name);
      if(entry.isDirectory()) walk(path);
      else if(/\.jsonl$/.test(entry.name)) for(const line of readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean)) {
        let row; try {row=JSON.parse(line);} catch {continue;}
        if(row.type==='assistant' && row.message?.usage) rows.push({file:entry.name,messageId:row.message.id??null,model:row.message.model??null,
          usage:row.message.usage,toolNames:(row.message.content||[]).filter(c=>c.type==='tool_use').map(c=>c.name)});
      }
    }
  };
  walk(transcriptDir);
  const unique=new Map();
  for(const row of rows) {
    const key=row.file+':'+(row.messageId??JSON.stringify(row.usage));
    const prior=unique.get(key);
    if(!prior || (row.usage.output_tokens??0)>(prior.usage.output_tokens??0)) unique.set(key,row);
  }
  return [...unique.values()];
}

export function classifyTtl(rows,ttl) {
  const writes=rows.map(r=>r.usage?.cache_creation);
  const known=writes.length>0 && writes.every(w=>Number.isFinite(w?.ephemeral_5m_input_tokens)&&Number.isFinite(w?.ephemeral_1h_input_tokens));
  const sum=key=>known?writes.reduce((n,w)=>n+w[key],0):null;
  const fiveMinuteWrites=sum('ephemeral_5m_input_tokens'),oneHourWrites=sum('ephemeral_1h_input_tokens');
  return {workerMessages:rows.length,fiveMinuteWrites,oneHourWrites,
    requestedTtlObserved:known && (ttl==='5m'?fiveMinuteWrites>0&&oneHourWrites===0:oneHourWrites>0&&fiveMinuteWrites===0),
    cacheReads:rows.length && rows.every(r=>Number.isFinite(r.usage?.cache_read_input_tokens))?rows.reduce((n,r)=>n+r.usage.cache_read_input_tokens,0):null,
    interpretation:known?'Per-worker transcript usage; TTL supported only when requestedTtlObserved=true':'Per-worker TTL unavailable; requested setting is not proof'};
}

export async function runCache(directory, executable) {
  const requested=resolve(directory);
  if(!existsSync(dirname(requested))) throw new Error('parent directory must exist');
  mkdirSync(requested);
  const dir=realpathSync.native(requested);
  const envKeys=['FORCE_PROMPT_CACHING_5M','ENABLE_PROMPT_CACHING_1H','CLAUDE_CODE_PROMPT_CACHE_TTL','CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL','DISABLE_PROMPT_CACHING','DISABLE_PROMPT_CACHING_HAIKU'];
  if(envKeys.some(k=>process.env[k])) throw new Error('inherited cache environment override present; refusing confounded run');
  const version=spawnSync(executable,['--version'],{encoding:'utf8',windowsHide:true});
  const reports=[];
  for(const ttl of ['5m','1h']) {
    const arm=join(dir,ttl);mkdirSync(arm);
    const nonce=randomUUID();
    const {prompt,script}=cacheScript(nonce);
    write(arm,'probe.js',script);write(arm,'settings.json',ttlSettings(ttl));
    const settingsPath=join(arm,'settings.json'),scriptPath=join(arm,'probe.js');
    const args=['-p',`Use Workflow({scriptPath:${JSON.stringify(scriptPath)}}) exactly once to run the existing authorized script without changing it. Wait using TaskOutput until completed. Do not run other workflows or tools. Return the exact result.`,
      '--session-id',randomUUID(),'--model','claude-sonnet-4-6','--effort','low','--output-format','stream-json','--verbose','--max-budget-usd','1','--max-turns','8',
      '--settings',settingsPath,'--setting-sources','','--permission-mode','dontAsk','--tools','Workflow,TaskOutput,Read',
      '--allowedTools','Workflow,TaskOutput,Read(./probe.js)','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
      '--system-prompt',`You run the single authorized synthetic workflow and wait for its result. Controller isolation nonce ${nonce}. Never edit files or launch other agents.`];
    write(arm,'request.json',{ttl,settings:ttlSettings(ttl),prompt:textMetrics(prompt),script:textMetrics(script),budgetUsd:1,maxWorkers:4});
    const call=await invoke(executable,args,arm,'run');
    let completion=null,launch=null,workers=[],error=null;
    try {
      completion=completedWorkflow(call.events);launch=launchIdentity(call.events);
      workers=extractWorkerUsage(launch.transcriptDir);
    } catch(e) {error=e.message;}
    const report={ttl,cliExit:call.summary.exitCode,cliError:call.summary.isError,settings:ttlSettings(ttl),completion,launch,workers,
      classification:classifyTtl(workers,ttl),error,controllerAndWorkersUsage:call.summary.modelUsage,cliReportedListUSD:call.summary.costUsd,actualBilledCost:null};
    write(arm,'report.json',report);reports.push(report);
  }
  const report={version:1,directory:dir,installedVersion:version.stdout.trim(),arms:reports,
    controlledTtlObserved:reports.every(r=>r.classification.requestedTtlObserved&&r.cliExit===0&&r.cliError===false
      &&r.completion?.agentCount===4&&r.completion?.result?.results?.length===4
      &&r.completion.result.results.every(x=>x?.value==='cache-ok')
      &&r.completion.workflowProgress.filter(x=>x.type==='workflow_agent').every(x=>x.state==='done'&&x.cached!==true)),
    expirationTested:false,automaticChanges:false,actualBilledCost:null,
    limitations:['Four sequential identical-prompt workers per arm; different nonce and directory isolate arms.','The controller is pinned to 5m in both arms.','No sleep or TTL-expiry measurement.','Aggregate CLI usage includes controller; worker transcript usage is reported separately.','Some transcript output-token fields are streaming partials; use CLI modelUsage for aggregate worker output, not summed transcript output.']};
  write(dir,'cache-experiment.json',report);return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.length!==4) throw new Error('Usage: node _workflow/live-benchmark-cache.mjs NEW_DIRECTORY CLAUDE_EXECUTABLE');
    console.log(JSON.stringify(await runCache(...process.argv.slice(2)),null,2));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
