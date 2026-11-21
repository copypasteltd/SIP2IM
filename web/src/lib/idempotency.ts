const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newIdempotencyKey():string { let time=Date.now(); let result=''; for(let i=0;i<10;i++){result=alphabet[time%32]+result;time=Math.floor(time/32);} const bytes=crypto.getRandomValues(new Uint8Array(16)); for(const byte of bytes) result+=alphabet[byte&31]; return result; }
