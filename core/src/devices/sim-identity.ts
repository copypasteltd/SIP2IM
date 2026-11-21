export interface SimIdentity {subId:number|null;carrier:string|null;mcc:string|null;mnc:string|null;state:string}
export function confirmedSimChange(old:SimIdentity,current:SimIdentity):boolean {if(current.state==='absent'&&old.state!=='absent')return true;return (['subId','carrier','mcc','mnc'] as const).some(key=>old[key]!==null&&current[key]!==null&&old[key]!==current[key]);}
