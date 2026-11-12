/** Uses the same staged catalog maintenance engine as the running API. */
import 'reflect-metadata';
import { DbService } from '../src/db/db';
import { DhanCatalogService } from '../src/market/dhan-catalog.service';
async function main(){const db=new DbService();const catalog=new DhanCatalogService(db);try{const result=await catalog.sync();console.log(JSON.stringify(result,null,2));if(result.status!=='HEALTHY')process.exitCode=1;}finally{await catalog.onModuleDestroy();await db.onApplicationShutdown();}}
void main().catch(()=>{console.error('Catalog sync failed. Check backend configuration and the integration status.');process.exitCode=1;});
