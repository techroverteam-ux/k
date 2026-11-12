/** Read-only catalog check against Dhan's official compact instrument master. */
import 'reflect-metadata';
import { baseSymbol } from '../src/trading/instrument-meta';
import { createPool } from '../src/db/db';

export function csvFields(line: string): string[] {
  const fields: string[] = []; let value = ''; let quoted = false;
  for (let i=0; i<line.length; i++) {
    const c=line[i];
    if(c === '"') { if(quoted && line[i+1] === '"') { value+='"';i++; } else quoted=!quoted; }
    else if(c === ',' && !quoted) {fields.push(value);value='';} else value+=c;
  }
  fields.push(value); return fields;
}
export function masterSegment(exchange: string, segment: string) {
  if(segment==='I')return 'IDX_I';
  if(exchange==='MCX')return 'MCX_COMM';
  return ({E:exchange+'_EQ', D:exchange+'_FNO', C:exchange+'_CURRENCY'} as Record<string,string>)[segment];
}
async function main() {
  const response=await fetch('https://images.dhan.co/api-data/api-scrip-master.csv',{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Instrument master HTTP '+response.status);
  const lines=(await response.text()).replace(/^\uFEFF/,'').split(/\r?\n/); const header=csvFields(lines.shift()!);
  const get=(f:string[],k:string)=>f[header.indexOf(k)];
  const master=new Map<string,{symbol:string;expiry:string}>();
  for(const line of lines) {
    if(!line)continue; const f=csvFields(line); const segment=masterSegment(get(f,'SEM_EXM_EXCH_ID'),get(f,'SEM_SEGMENT'));
    if(segment)master.set(segment+':'+get(f,'SEM_SMST_SECURITY_ID'),{symbol:get(f,'SEM_TRADING_SYMBOL'),expiry:get(f,'SEM_EXPIRY_DATE')});
  }
  const globalResponse=await fetch('https://api-global-stocks.dhan.co/api-data/us-stock-scrip-master.csv',{signal:AbortSignal.timeout(30000)});
  if(!globalResponse.ok)throw new Error('Global instrument master HTTP '+globalResponse.status);
  const globalLines=(await globalResponse.text()).split(/\r?\n/);const globalHeader=csvFields(globalLines.shift()!);
  const globalMaster=new Map<string,string>();
  for(const line of globalLines){if(!line)continue;const f=csvFields(line);globalMaster.set(f[globalHeader.indexOf('SCRIP_CODE')],f[globalHeader.indexOf('SYMBOL')]);}
  const pool=createPool();
  try {
    const {rows}=await pool.query<{symbol:string;dhan_segment:string;dhan_security_id:string;expiry:Date|null}>(`SELECT symbol,dhan_segment,dhan_security_id,expiry FROM instruments WHERE active=true ORDER BY symbol`);
    const issues: unknown[]=[]; let verified=0,global=0; const seen=new Set<string>();
    for(const row of rows) {
      const key=row.dhan_segment+':'+row.dhan_security_id;
      if(!row.dhan_segment||!row.dhan_security_id){issues.push({symbol:row.symbol,issue:'No live mapping'});continue;}
      if(seen.has(key))issues.push({symbol:row.symbol,issue:'Duplicate segment/security ID'});seen.add(key);
      if(row.dhan_segment==='INX_EQ'){if(globalMaster.get(row.dhan_security_id)!==row.symbol)issues.push({symbol:row.symbol,issue:'Global symbol/security ID mismatch',masterSymbol:globalMaster.get(row.dhan_security_id)});else global++;continue;}
      const source=master.get(key);
      if(!source){issues.push({symbol:row.symbol,issue:'Absent from official master',key});continue;}
      if(baseSymbol(row.symbol)!==baseSymbol(source.symbol)){issues.push({symbol:row.symbol,issue:'Symbol/security ID mismatch',master:source});continue;}
      const date=source.expiry?.slice(0,10);
      if(date && date!=='0001-01-01' && date<new Date(Date.now()+19800000).toISOString().slice(0,10)) issues.push({symbol:row.symbol,issue:'Expired official contract',master:source});
      else if(row.expiry && date && row.expiry.toISOString().slice(0,10)!==date) issues.push({symbol:row.symbol,issue:'Expiry mismatch',stored:row.expiry.toISOString(),master:source});
      else verified++;
    }
    console.log(JSON.stringify({verifiedDomestic:verified,verifiedGlobal:global,issues},null,2));
    if(issues.length)process.exitCode=1;
  } finally {await pool.end();}
}
if(require.main===module)void main().catch(()=>{console.error('Catalog audit failed; verify database configuration and Dhan availability.');process.exitCode=1;});
