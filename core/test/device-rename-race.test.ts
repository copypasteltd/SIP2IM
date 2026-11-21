import {expect,it} from 'vitest';
import type pg from 'pg';
import {DeviceAdminRepository} from '../src/devices/admin-repo.js';

it('serializes competing conditional renames using the database row lock',async()=>{
  let name='Original'; let locked=Promise.resolve();
  const queries:string[]=[];
  const pool={connect:async()=>{let unlock!:()=>void;return {query:async(sql:string,params?:unknown[])=>{
    queries.push(sql);
    if(sql==='BEGIN')return {command:'BEGIN'};
    if(sql.includes('FOR UPDATE')){const previous=locked;locked=new Promise<void>(resolve=>{unlock=resolve});await previous;return {rowCount:1,rows:[{name}]};}
    if(sql.startsWith('UPDATE device SET name=')){name=params![1] as string;return {rowCount:1,rows:[{id:params![0],name}]};}
    if(sql==='COMMIT'){unlock();return {command:'COMMIT'};}
    throw Error(sql);
  },release:()=>{}};}} as unknown as pg.Pool;
  const first=new DeviceAdminRepository(pool),second=new DeviceAdminRepository(pool);
  expect(await Promise.all([first.update('d',{name:'A',expectedName:'Original'}),second.update('d',{name:'B',expectedName:'Original'})])).toEqual([{id:'d',name:'A'},'conflict']);
  expect(name).toBe('A');expect(queries.filter(q=>q.startsWith('UPDATE device SET name='))).toHaveLength(1);
});

it('rejects invalid conditional patches before accessing the database',async()=>{
 const repo=new DeviceAdminRepository({} as pg.Pool);
 await expect(repo.update('d',{expectedName:'old'})).rejects.toThrow('Invalid conditional device rename');
 await expect(repo.update('d',{name:'new',expectedName:'old',enabled:false})).rejects.toThrow('Invalid conditional device rename');
});

it('distinguishes an absent device from a name mismatch',async()=>{
 const pool={connect:async()=>({query:async(sql:string)=>sql==='BEGIN'?{command:'BEGIN'}:sql==='COMMIT'?{command:'COMMIT'}:{rowCount:0,rows:[]},release:()=>{}})} as unknown as pg.Pool;
 expect(await new DeviceAdminRepository(pool).update('missing',{name:'new',expectedName:'old'})).toBe(false);
});
